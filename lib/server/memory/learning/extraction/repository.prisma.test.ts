import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../../domain/content";
import { providerTemplateIds } from "../../../../domain/providerTemplates";
import { prisma } from "../../../prisma";
import type { MemoryJobClaim } from "../../coordinator/types";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  memorySha256,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import { loadPersonalEligibleFactVersionIds } from "../../persistence/eligibility";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../../retrieval/vector";
import {
  memoryReclassificationAcceptedOutputHash,
  memoryReclassificationInputHash
} from "../../reclassification/classifier";
import { createPrismaMemoryReclassificationRepository } from "../../reclassification/repository";
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
    targetFactVersionId: claimed.targetFactVersionId,
    userId: claimed.userId
  };
}

function extractionPlan(
  input: MemoryFactExtractionInput,
  quote: string,
  statement = "The user bought a MacBook Air.",
  state = "owned",
  temporal: Readonly<{
    expected_at: string | null;
    expires_at: string | null;
    occurred_at: string | null;
    raw_expression: string | null;
    valid_from: string | null;
    valid_to: string | null;
  }> = {
    expected_at: null,
    expires_at: null,
    occurred_at: null,
    raw_expression: null,
    valid_from: null,
    valid_to: null
  }
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        confidence_band: "HIGH",
        correction: false,
        dependency_refs: [],
        entities: [],
        future_useful: true,
        identity: {
          dimension_key: null,
          mode: "SLOT",
          predicate_key: "product_status",
          subject: {
            canonical_label: "MacBook Air",
            entity_type: "DEVICE",
            qualifiers: { brand: "Apple", model: "MacBook Air" }
          }
        },
        memory_type: "EVENT",
        quote,
        reason_code: "durable_direct_fact",
        sensitivity: "NORMAL",
        statement,
        temporal,
        temporary: false,
        value: {
          frequency: null,
          kind: null,
          limit: null,
          place: null,
          role: null,
          schedule: null,
          state,
          strength: null,
          value: null
        }
      }]
    },
    id: `fact-call-${randomUUID()}`,
    name: MEMORY_FACT_EXTRACTION_TOOL_NAME
  }], input);
}

function contextualProductPlan(
  input: MemoryFactExtractionInput,
  contextRef: string
): MemoryFactExtractionPlan {
  const quote = "Я заказал макбук.";
  return decodeMemoryFactExtraction([{
    arguments: {
      observations: [{
        confidence_band: "HIGH",
        correction: false,
        dependency_refs: [contextRef],
        entities: [{
          aliases: ["макбук"],
          canonical_label: null,
          context_entity_ref: contextRef,
          entity_type: "DEVICE",
          mention: "макбук",
          role: "SUBJECT"
        }],
        future_useful: true,
        identity: {
          dimension_key: null,
          mode: "SLOT",
          predicate_key: "product_status",
          subject: {
            canonical_label: "MacBook Air",
            entity_type: "DEVICE",
            qualifiers: { brand: "Apple", model: "MacBook Air" }
          }
        },
        memory_type: "EVENT",
        quote,
        reason_code: "context_resolved_order",
        sensitivity: "NORMAL",
        statement: "Пользователь заказал MacBook Air.",
        temporal: {
          expected_at: null,
          expires_at: null,
          occurred_at: null,
          raw_expression: null,
          valid_from: null,
          valid_to: null
        },
        temporary: false,
        value: {
          frequency: null,
          kind: null,
          limit: null,
          place: null,
          role: null,
          schedule: null,
          state: "ordered",
          strength: null,
          value: null
        }
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
  bindingId: string,
  now = new Date()
) {
  return withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    repository().apply(tx, settings, claim, plan, bindingId, now));
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
        { evidenceEligible: true, id: first.userMessage.id, role: "user" }
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
        safetyClassificationState: "PENDING",
        observedAt: first.userMessage.createdAt,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE"
      });
      expect(versions[0]!.ingestionFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      await expect(prisma.memoryFactVersion.update({
        data: { observedAt: second.userMessage.createdAt },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/observedAt is immutable once assigned/u);
      await expect(prisma.memoryFactVersion.update({
        data: { displayText: "A rewritten semantic observation." },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/semantic observation is immutable/u);
      await expect(prisma.memoryFactVersion.update({
        data: { ingestionFingerprint: null },
        where: { id: versions[0]!.id }
      })).rejects.toThrow(/ingestionFingerprint is immutable once assigned/u);
      await expect(prisma.memoryFactVersion.create({
        data: {
          category: versions[0]!.category,
          confidence: versions[0]!.confidence,
          coreEligible: versions[0]!.coreEligible,
          coreSalience: versions[0]!.coreSalience,
          createdByEventId: versions[0]!.createdByEventId,
          directness: versions[0]!.directness,
          displayText: versions[0]!.displayText,
          factId: versions[0]!.factId,
          id: randomUUID(),
          importance: versions[0]!.importance,
          languageCode: versions[0]!.languageCode,
          modality: versions[0]!.modality,
          normalizedSearchText: versions[0]!.normalizedSearchText,
          pipelineVersion: "memory-vnext-active-duplicate-test",
          sensitivityClass: versions[0]!.sensitivityClass,
          sourceMode: "EXPLICIT",
          state: "ACTIVE",
          structuredValue: versions[0]!.structuredValue as Prisma.InputJsonValue,
          userId
        }
      })).rejects.toMatchObject({ code: "P2002" });
      expect(evidence).toHaveLength(2);
      expect(evidence.map((item) => ({
        contentHash: item.sourceMessageContentHash,
        endOffset: item.sourceEndOffset,
        evidenceFingerprint: item.evidenceFingerprint,
        excerpt: item.safeExcerpt,
        messageId: item.messageId,
        role: item.sourceRole,
        startOffset: item.sourceStartOffset
      }))).toEqual([
        {
          contentHash: memorySha256("I bought a MacBook Air."),
          endOffset: "I bought a MacBook Air.".length,
          evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          excerpt: "I bought a MacBook Air.",
          messageId: first.userMessage.id,
          role: "user",
          startOffset: 0
        },
        {
          contentHash: memorySha256("I bought a MacBook Air."),
          endOffset: "I bought a MacBook Air.".length,
          evidenceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          excerpt: "I bought a MacBook Air.",
          messageId: second.userMessage.id,
          role: "user",
          startOffset: 0
        }
      ]);
      expect(evidence[0]!.evidenceFingerprint)
        .not.toBe(evidence[1]!.evidenceFingerprint);
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryEntityAliasSupport.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryFactVersionEntity.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.update({
        data: { sourceStartOffset: 1 },
        where: { id: evidence[0]!.id }
      })).rejects.toThrow(/exact provenance is immutable once assigned/u);
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: {
          kind: { in: ["CONSOLIDATE_CANDIDATE", "VERIFY_CANDIDATE"] },
          userId
        }
      })).resolves.toBe(0);
      await expect(prisma.memoryEvent.count({
        where: { operation: "PROMOTE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvent.count({
        where: { operation: "REINFORCE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvidence.create({
        data: {
          branchGeneration: evidence[0]!.branchGeneration,
          chatId: evidence[0]!.chatId,
          evidenceFingerprint: memorySha256({ probe: randomUUID() }),
          factVersionId: evidence[0]!.factVersionId,
          messageId: null,
          observedAt: evidence[0]!.observedAt,
          safeExcerpt: evidence[0]!.safeExcerpt,
          safeSourceHash: evidence[0]!.safeSourceHash,
          safetyClass: evidence[0]!.safetyClass,
          sourceEndOffset: evidence[0]!.sourceEndOffset,
          sourceMessageContentHash: evidence[0]!.sourceMessageContentHash,
          sourceProjectionVersion: evidence[0]!.sourceProjectionVersion,
          sourceRole: evidence[0]!.sourceRole,
          sourceStartOffset: evidence[0]!.sourceStartOffset,
          sourceType: evidence[0]!.sourceType,
          stance: evidence[0]!.stance,
          userId
        }
      })).rejects.toThrow(/MemoryEvidence_exact_provenance_check/u);
      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.update({
          data: { currentVersionId: null, state: "RETRACTED" },
          where: { id: versions[0]!.factId }
        });
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED" },
          where: { id: versions[0]!.id }
        });
        await tx.memoryEvidence.deleteMany({
          where: { factVersionId: versions[0]!.id, userId }
        });
      });
      await expect(prisma.$transaction(async (tx) => {
        await tx.memoryFactVersion.update({
          data: { state: "ACTIVE" },
          where: { id: versions[0]!.id }
        });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "MemoryFactVersion_vnext_evidence_assert" IMMEDIATE'
        );
      })).rejects.toThrow(/require exact direct-user evidence/u);
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
        arguments: { observations: [] },
        id: `fact-call-${randomUUID()}`,
        name: MEMORY_FACT_EXTRACTION_TOOL_NAME
      }], input);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("EMPTY");
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: claim.id } }))
        .resolves.toMatchObject({ stage: "fact_observations_empty_applied" });
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("persists cross-chat entity context as a fact dependency with exact target evidence", async () => {
    const userId = await createOwner("context-dependency");
    try {
      await activateHybridIndex(userId);
      const sourceChat = await prisma.chat.create({
        data: { title: "MacBook source", userId }
      });
      const sourceTurn = await createTurn({
        assistantText: "Purchase noted.",
        chatId: sourceChat.id,
        createdAt: new Date("2026-08-24T06:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, sourceChat.id, sourceTurn);
      const sourceClaim = await claimFactJob(userId, sourceTurn.userMessage.id);
      const sourceInput = await prepare(sourceClaim);
      const sourcePlan = extractionPlan(
        sourceInput,
        "I bought a MacBook Air."
      );
      const sourceBinding = await createSucceededBinding(
        userId,
        sourceClaim,
        sourceInput.inputHash,
        sourcePlan.outputHash
      );
      await expect(applyPlan(
        userId,
        sourceClaim,
        sourcePlan,
        sourceBinding
      )).resolves.toBe("APPLIED");
      const sourceVersion = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      const safety = createPrismaMemoryReclassificationRepository(prisma);
      const pending = (await safety.pending(userId)).find(({ id }) =>
        id === sourceVersion.id);
      if (!pending) throw new Error("memory_context_source_pending_missing");
      const classifiedAt = new Date("2026-08-24T06:00:30.000Z");
      const decision = {
        category: "about_you" as const,
        reasonCode: "ordinary_personal" as const,
        responsePreference: false,
        sensitivity: "NORMAL" as const,
        storageDecision: "ALLOW" as const,
        subjectScope: "USER" as const
      };
      const classifierInputHash = memoryReclassificationInputHash(
        pending.displayText,
        pending.sourceMode
      );
      await prisma.$transaction((tx) => safety.apply(tx, userId, [{
        candidate: pending,
        result: {
          acceptedOutputHash: memoryReclassificationAcceptedOutputHash(
            classifierInputHash,
            decision
          ),
          classifiedAt,
          decision,
          executionId: sourceBinding,
          inputHash: classifierInputHash,
          modelId: "memory-vnext-test-model",
          policyVersion: "memory-context-test-v1",
          providerId: "openai_compatible"
        }
      }], classifiedAt));

      const contextChat = await prisma.chat.create({
        data: { title: "MacBook context", userId }
      });
      const contextTurn = await createTurn({
        assistantText: "Order noted.",
        chatId: contextChat.id,
        createdAt: new Date("2026-08-24T06:01:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "Я заказал макбук."
      });
      await settleChat(userId, contextChat.id, contextTurn);
      const contextClaim = await claimFactJob(userId, contextTurn.userMessage.id);
      const contextInput = await prepare(contextClaim);
      const factRef = contextInput.contextRefs.find(({ kind }) =>
        kind === "FACT_VERSION");
      expect(factRef).toMatchObject({
        displayName: "MacBook Air",
        entityType: "DEVICE",
        source: { factVersionId: sourceVersion.id }
      });
      expect(factRef?.entityId).toMatch(/^[a-f0-9]{64}$/u);
      const contextPlan = contextualProductPlan(contextInput, factRef!.ref);
      expect(contextPlan.rejections).toEqual([]);
      const contextBinding = await createSucceededBinding(
        userId,
        contextClaim,
        contextInput.inputHash,
        contextPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        contextClaim,
        contextPlan,
        contextBinding
      )).resolves.toBe("APPLIED");

      const dependency = await prisma.memoryFactVersionSourceDependency
        .findFirstOrThrow({ where: { userId } });
      expect(dependency).toMatchObject({
        dependencyKind: "COREFERENCE_ANTECEDENT",
        sourceFactVersionId: sourceVersion.id
      });
      const targetEvidence = await prisma.memoryEvidence.findMany({
        where: { factVersionId: dependency.targetFactVersionId, userId }
      });
      expect(targetEvidence).toHaveLength(1);
      expect(targetEvidence[0]).toMatchObject({
        messageId: contextTurn.userMessage.id,
        safeExcerpt: "Я заказал макбук.",
        sourceRole: "user"
      });
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryEntityAlias.findMany({
        orderBy: { normalizedAlias: "asc" },
        select: { normalizedAlias: true },
        where: { userId }
      })).resolves.toEqual([
        { normalizedAlias: "macbook air" },
        { normalizedAlias: "макбук" }
      ]);

      const replacement = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: textMessageContent("Replacement source branch."),
          createdAt: new Date("2026-08-24T06:02:00.000Z"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: replacement.id },
        where: { id: sourceChat.id }
      });
      await expect(prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_fact_dependencies_valid(
          ${userId},
          ${dependency.targetFactVersionId}
        ) AS valid
      `)).resolves.toEqual([{ valid: false }]);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: dependency.targetFactVersionId, userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("converges assistant regeneration on one exact source-message job", async () => {
    const userId = await createOwner("regeneration");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Assistant regeneration", userId }
      });
      const original = await createTurn({
        assistantText: "First answer.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T11:10:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, original);
      const originalJob = await claimFactJob(userId, original.userMessage.id);
      const originalInput = await prepare(originalJob);
      const originalPlan = extractionPlan(
        originalInput,
        "I bought a MacBook Air."
      );
      const originalBinding = await createSucceededBinding(
        userId,
        originalJob,
        originalInput.inputHash,
        originalPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        originalJob,
        originalPlan,
        originalBinding
      )).resolves.toBe("APPLIED");
      const learnedVersion = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: original.assistantMessage.id,
          chatId: chat.id,
          createdAt: new Date(original.run.createdAt.getTime() + 1_000),
          modelId: "memory-vnext-test-model",
          normalizedRequest: {
            prompt: {
              baseline: {
                source: "standard_chat",
                timeZone: "America/New_York",
                timeZoneSource: "client"
              }
            }
          },
          provider: "memory-vnext-test-provider",
          status: "complete",
          userId,
          userMessageId: original.userMessage.id
        }
      });
      const assistantAt = new Date("2026-08-22T11:10:02.000Z");
      const regeneratedAssistant = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Regenerated answer."),
          createdAt: assistantAt,
          modelId: "memory-vnext-test-model",
          parentMessageId: original.userMessage.id,
          provider: "memory-vnext-test-provider",
          role: "assistant",
          status: "complete",
          updatedAt: assistantAt
        }
      });
      const regeneratedRun = await prisma.modelRun.create({
        data: {
          assistantMessageId: regeneratedAssistant.id,
          chatId: chat.id,
          modelId: "memory-vnext-test-model",
          normalizedRequest: {
            prompt: {
              baseline: {
                source: "standard_chat",
                timeZone: "Asia/Tokyo",
                timeZoneSource: "client"
              }
            }
          },
          provider: "memory-vnext-test-provider",
          status: "complete",
          userId,
          userMessageId: original.userMessage.id
        }
      });
      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("memory_vnext_test_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["BRANCH_PATH_CHANGE"],
          patch: { activeLeafMessageId: regeneratedAssistant.id }
        });
      });
      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("memory_vnext_test_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["TERMINAL_SETTLEMENT"],
          terminalSettlement: {
            assistantMessageId: regeneratedAssistant.id,
            runId: regeneratedRun.id,
            status: "complete"
          }
        });
      });

      const jobs = await prisma.memoryJob.findMany({
        where: {
          kind: "EXTRACT_FACTS",
          sourceMessageId: original.userMessage.id,
          userId
        }
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.idempotencyFingerprint)
        .toBe(originalJob.idempotencyFingerprint);
      await expect(repository().preflight(originalJob)).resolves.toEqual({
        status: "READY"
      });
      await expect(prepare(originalJob)).resolves.toMatchObject({
        inputHash: originalInput.inputHash,
        timeZone: "Europe/Moscow"
      });
      await expect(loadPersonalEligibleFactVersionIds(
        prisma,
        userId,
        [learnedVersion.id]
      )).resolves.toEqual(new Set([learnedVersion.id]));
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryFact.findFirstOrThrow({ where: { userId } }))
        .resolves.toMatchObject({
          currentVersionId: learnedVersion.id,
          state: "ACTIVE"
        });
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

  it("rejects a delayed job when the active branch no longer contains its source", async () => {
    const userId = await createOwner("branch-exclusion");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Branch exclusion", userId }
      });
      const retained = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:10:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, retained);
      const claim = await claimFactJob(userId, retained.userMessage.id);
      const sibling = await createTurn({
        assistantText: "A separate branch.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T12:11:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "This branch replaces the first one."
      });
      await prisma.$transaction(async (tx) => {
        const locked = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!locked) throw new Error("memory_vnext_test_chat_missing");
        await applyMemorySourceMutations(tx, {
          chat: locked,
          hooks: defaultMemorySourceMutationHooks,
          mutations: ["BRANCH_PATH_CHANGE"],
          patch: { activeLeafMessageId: sibling.assistantMessage.id }
        });
      });

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

  it("commits safety-pending semantics without creating an index or embedding job", async () => {
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
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryJob.count({
        where: { kind: "EMBED_ITEMS", state: "QUEUED", userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("reinforces the exact value without replacing explicit authority", async () => {
    const userId = await createOwner("explicit-authority");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Explicit authority reinforcement", userId }
      });
      const turn = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-23T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId, turn.userMessage.id);
      const source = await prepare(claim);
      const plan = extractionPlan(source, "I bought a MacBook Air.");
      const candidate = plan.candidates[0]!;
      const scope = await prisma.memoryScope.create({
        data: { scopeType: "GLOBAL_USER", userId }
      });
      const factId = randomUUID();
      const versionId = randomUUID();
      const eventId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.create({
          data: {
            canonicalKey: candidate.canonicalKey,
            category: candidate.category,
            dimensionKey: candidate.dimensionKey,
            id: factId,
            identityKind: candidate.identityKind,
            identityVersion: candidate.identityVersion,
            predicateKey: candidate.predicateKey,
            scopeId: scope.id,
            state: "ORPHANED",
            subjectKey: candidate.subjectKey,
            userId
          }
        });
        await tx.memoryEvent.create({
          data: {
            actorType: "USER",
            actorUserId: userId,
            factId,
            factVersionId: versionId,
            id: eventId,
            operation: "EXPLICIT_SAVE",
            userId
          }
        });
        await tx.memoryFactVersion.create({
          data: {
            category: candidate.category,
            confidence: 1,
            createdByEventId: eventId,
            directness: "DIRECT",
            displayText: candidate.displayText,
            factId,
            id: versionId,
            importance: 1,
            languageCode: candidate.languageCode,
            modality: candidate.modality,
            normalizedSearchText: normalizeMemorySearchText(candidate.displayText),
            pipelineVersion: "memory-explicit-authority-test-v1",
            safetyClassificationState: "PENDING",
            sensitivityClass: "NORMAL",
            sourceMode: "EXPLICIT",
            state: "ACTIVE",
            structuredValue: candidate.proposedValue as Prisma.InputJsonValue,
            userId
          }
        });
        await tx.memoryEvidence.create({
          data: {
            factVersionId: versionId,
            memoryEventId: eventId,
            observedAt: turn.userMessage.createdAt,
            safeExcerpt: candidate.displayText,
            safeSourceHash: memorySha256(candidate.displayText),
            safetyClass: "NORMAL",
            sourceProjectionVersion: "memory-explicit-authority-test-v1",
            sourceType: "EXPLICIT_ACTION",
            stance: "SUPPORTS",
            userId
          }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: versionId, state: "ACTIVE" },
          where: { id: factId }
        });
      });

      const bindingId = await createSucceededBinding(
        userId,
        claim,
        source.inputHash,
        plan.outputHash
      );
      await expect(applyPlan(userId, claim, plan, bindingId)).resolves.toBe("APPLIED");

      await expect(prisma.memoryFactVersion.findMany({ where: { userId } }))
        .resolves.toMatchObject([{
          id: versionId,
          sourceMode: "EXPLICIT",
          state: "ACTIVE"
        }]);
      await expect(prisma.memoryEvidence.count({ where: { factVersionId: versionId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryEvent.count({
        where: { factVersionId: versionId, operation: "REINFORCE", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("stages a different SLOT value and safety rejection preserves the older current", async () => {
    const userId = await createOwner("pending-relation");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Relation staging", userId }
      });
      const ordered = await createTurn({
        assistantText: "Order noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T08:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I ordered a MacBook Air."
      });
      await settleChat(userId, chat.id, ordered);
      const purchased = await createTurn({
        assistantText: "Purchase noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T08:01:00.000Z"),
        parentMessageId: ordered.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, purchased);
      const orderedClaim = await claimFactJob(userId, ordered.userMessage.id);
      const purchasedClaim = await claimFactJob(userId, purchased.userMessage.id);
      const orderedInput = await prepare(orderedClaim);
      const purchasedInput = await prepare(purchasedClaim);
      const orderedPlan = extractionPlan(
        orderedInput,
        "I ordered a MacBook Air.",
        "The user ordered a MacBook Air.",
        "ordered"
      );
      const purchasedPlan = extractionPlan(
        purchasedInput,
        "I bought a MacBook Air.",
        "The user owns a MacBook Air.",
        "owned"
      );
      const orderedBinding = await createSucceededBinding(
        userId,
        orderedClaim,
        orderedInput.inputHash,
        orderedPlan.outputHash
      );
      const purchasedBinding = await createSucceededBinding(
        userId,
        purchasedClaim,
        purchasedInput.inputHash,
        purchasedPlan.outputHash
      );
      await expect(applyPlan(
        userId,
        orderedClaim,
        orderedPlan,
        orderedBinding
      )).resolves.toBe("APPLIED");
      await expect(applyPlan(
        userId,
        purchasedClaim,
        purchasedPlan,
        purchasedBinding
      )).resolves.toBe("APPLIED");

      const fact = await prisma.memoryFact.findFirstOrThrow({ where: { userId } });
      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ systemFrom: "asc" }, { id: "asc" }],
        where: { userId }
      });
      expect(fact).toMatchObject({
        canonicalKey: "slot:v2:device:apple:macbook-air:product_status:_",
        currentVersionId: versions.find(({ state }) => state === "ACTIVE")?.id,
        dimensionKey: null,
        identityKind: "SLOT",
        identityVersion: "slot-v2",
        predicateKey: "product_status"
      });
      expect(versions.map(({ safetyClassificationState, state }) => ({
        safetyClassificationState,
        state
      }))).toEqual([
        { safetyClassificationState: "PENDING", state: "ACTIVE" },
        { safetyClassificationState: "PENDING", state: "PENDING_RELATION" }
      ]);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(0);

      const safety = createPrismaMemoryReclassificationRepository(prisma);
      const pending = (await safety.pending(userId))
        .find(({ semanticState }) => semanticState === "PENDING_RELATION");
      if (!pending) throw new Error("memory_pending_relation_fixture_missing");
      const rejectedAt = new Date("2026-08-24T09:00:00.000Z");
      await prisma.$transaction((tx) => safety.apply(tx, userId, [{
        candidate: pending,
        result: {
          classifiedAt: rejectedAt,
          decision: {
            category: "other",
            reasonCode: "secret_material",
            responsePreference: false,
            sensitivity: "SECRET",
            storageDecision: "REJECT_SECRET",
            subjectScope: "USER"
          },
          executionId: null,
          modelId: "format-aware-secret-parser-v1",
          policyVersion: "memory-local-secret-parser-v1",
          providerId: "aiqsa-local-policy"
        }
      }], rejectedAt));

      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: fact.id }
      })).resolves.toMatchObject({
        currentVersionId: fact.currentVersionId,
        state: "ACTIVE"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: pending.id }
      })).resolves.toMatchObject({
        contentPurgedAt: rejectedAt,
        safetyClassificationState: "SECRET_FENCED",
        state: "RETRACTED"
      });
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: fact.currentVersionId!, userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("materializes elapsed explicit TTL before reusing the same identity", async () => {
    const userId = await createOwner("expiration");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Explicit expiration", userId }
      });
      const temporary = await createTurn({
        assistantText: "Temporarily noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText:
          "Remember this until 2026-08-25: I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, temporary);
      const firstClaim = await claimFactJob(userId, temporary.userMessage.id);
      const firstInput = await prepare(firstClaim);
      const firstPlan = extractionPlan(
        firstInput,
        "Remember this until 2026-08-25: I bought a MacBook Air.",
        "The user owns a MacBook Air.",
        "owned",
        {
          expected_at: null,
          expires_at: null,
          occurred_at: null,
          raw_expression: "Remember this until 2026-08-25",
          valid_from: null,
          valid_to: null
        }
      );
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await prisma.memoryJob.update({
        data: { leaseExpiresAt: new Date("2026-08-27T00:00:00.000Z") },
        where: { id: firstClaim.id }
      });
      await expect(applyPlan(
        userId,
        firstClaim,
        firstPlan,
        firstBinding,
        new Date("2026-08-24T12:00:00.000Z")
      )).resolves.toBe("APPLIED");

      const permanent = await createTurn({
        assistantText: "Noted again.",
        chatId: chat.id,
        createdAt: new Date("2026-08-26T00:00:00.000Z"),
        parentMessageId: temporary.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, permanent);
      const secondClaim = await claimFactJob(userId, permanent.userMessage.id);
      const secondInput = await prepare(secondClaim);
      const secondPlan = extractionPlan(
        secondInput,
        "I bought a MacBook Air.",
        "The user owns a MacBook Air."
      );
      const secondBinding = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await prisma.memoryJob.update({
        data: { leaseExpiresAt: new Date("2026-08-27T00:00:00.000Z") },
        where: { id: secondClaim.id }
      });
      await expect(applyPlan(
        userId,
        secondClaim,
        secondPlan,
        secondBinding,
        new Date("2026-08-26T01:00:00.000Z")
      )).resolves.toBe("APPLIED");

      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ systemFrom: "asc" }, { id: "asc" }],
        where: { userId }
      });
      const expired = versions.find(({ state }) => state === "EXPIRED");
      const active = versions.find(({ state }) => state === "ACTIVE");
      expect(expired).toMatchObject({
        expiresAt: new Date("2026-08-25T21:00:00.000Z"),
        state: "EXPIRED",
        systemTo: new Date("2026-08-26T01:00:00.000Z")
      });
      expect(active).toMatchObject({ expiresAt: null, state: "ACTIVE" });
      await expect(prisma.memoryFact.findFirstOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        currentVersionId: active?.id,
        state: "ACTIVE"
      });
      await expect(prisma.memoryEvent.count({
        where: { operation: "EXPIRE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({
        where: { factVersionId: expired?.id, userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("creates a new immutable version when fresh evidence re-establishes a retracted fact", async () => {
    const userId = await createOwner("reobserve-retracted");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Fresh evidence after source invalidation", userId }
      });
      const first = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, first);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const firstInput = await prepare(firstClaim);
      const firstPlan = extractionPlan(firstInput, "I bought a MacBook Air.");
      const firstBinding = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await expect(applyPlan(userId, firstClaim, firstPlan, firstBinding))
        .resolves.toBe("APPLIED");
      const original = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      });
      const invalidatedAt = new Date(original.systemFrom.getTime() + 1);
      await prisma.$transaction(async (tx) => {
        await tx.memoryEvent.create({
          data: {
            actorType: "SYSTEM",
            factId: original.factId,
            factVersionId: original.id,
            operation: "SOURCE_INVALIDATE",
            userId
          }
        });
        await tx.memoryFactVersion.update({
          data: { state: "RETRACTED", systemTo: invalidatedAt },
          where: { id: original.id }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: null, state: "RETRACTED" },
          where: { id: original.factId }
        });
        await tx.memoryEvidence.deleteMany({
          where: { factVersionId: original.id, userId }
        });
      });

      const second = await createTurn({
        assistantText: "Noted again from fresh evidence.",
        chatId: chat.id,
        createdAt: new Date("2026-08-24T10:02:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, second);
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

      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: [{ systemFrom: "asc" }, { id: "asc" }],
        where: { factId: original.factId, userId }
      });
      expect(versions).toHaveLength(2);
      expect(versions.find(({ id }) => id === original.id)).toMatchObject({
        state: "RETRACTED",
        systemTo: invalidatedAt
      });
      const current = versions.find(({ id }) => id !== original.id);
      expect(current).toMatchObject({ state: "ACTIVE", systemTo: null });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: original.factId }
      })).resolves.toMatchObject({
        currentVersionId: current?.id,
        movedToFactId: null,
        state: "ACTIVE"
      });
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: current?.id, userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: original.id, userId }
      })).resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("converges concurrent same-value observations to one version and two supports", async () => {
    const userId = await createOwner("concurrent-reinforcement");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Concurrent reinforcement", userId }
      });
      const first = await createTurn({
        assistantText: "Noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T17:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, first);
      const second = await createTurn({
        assistantText: "Confirmed.",
        chatId: chat.id,
        createdAt: new Date("2026-08-22T17:01:00.000Z"),
        parentMessageId: first.assistantMessage.id,
        userId,
        userText: "I bought a MacBook Air."
      });
      await settleChat(userId, chat.id, second);
      const firstClaim = await claimFactJob(userId, first.userMessage.id);
      const secondClaim = await claimFactJob(userId, second.userMessage.id);
      const [firstInput, secondInput] = await Promise.all([
        prepare(firstClaim),
        prepare(secondClaim)
      ]);
      const firstPlan = extractionPlan(firstInput, "I bought a MacBook Air.");
      const secondPlan = extractionPlan(secondInput, "I bought a MacBook Air.");
      const [firstBinding, secondBinding] = await Promise.all([
        createSucceededBinding(
          userId,
          firstClaim,
          firstInput.inputHash,
          firstPlan.outputHash
        ),
        createSucceededBinding(
          userId,
          secondClaim,
          secondInput.inputHash,
          secondPlan.outputHash
        )
      ]);

      await expect(Promise.all([
        applyPlan(userId, firstClaim, firstPlan, firstBinding),
        applyPlan(userId, secondClaim, secondPlan, secondBinding)
      ])).resolves.toEqual(["APPLIED", "APPLIED"]);

      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryEvidence.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryEvent.count({ where: { userId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });
});
