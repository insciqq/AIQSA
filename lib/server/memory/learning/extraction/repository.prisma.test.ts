import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../../domain/content";
import { prisma } from "../../../prisma";
import type {
  MemoryDeletionClaim,
  MemoryJobClaim
} from "../../coordinator/types";
import {
  memoryHistorySourceDeletionHandler,
  reconcileCompletedMemoryHistorySourceDeletionAudits
} from "../../history/purge";
import { memorySha256 } from "../../persistence/lexical";
import { createMemorySuppressionInTransaction } from "../../persistence/suppressions";
import { withLockedMemoryTransaction } from "../../persistence/transaction";
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
  memoryFactExtractionOutputHash,
  type MemoryExtractedCandidate,
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
  const userId = `memory-fact-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory fact extraction test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: {
      learnAutomatically: true,
      referenceChatHistory: false
    },
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
      modelId: "memory-fact-test-model",
      parentMessageId: userMessage.id,
      provider: "memory-fact-test-provider",
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  const run = await prisma.modelRun.create({
    data: {
      assistantMessageId: assistantMessage.id,
      chatId: input.chatId,
      modelId: "memory-fact-test-model",
      normalizedRequest: {
        prompt: {
          baseline: {
            source: "standard_chat",
            timeZone: "Europe/Moscow",
            timeZoneSource: "client"
          }
        }
      },
      provider: "memory-fact-test-provider",
      status: "complete",
      userId: input.userId,
      userMessageId: userMessage.id
    }
  });
  return { assistantMessage, run, userMessage };
}

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
    if (!chat) throw new Error("memory_fact_test_chat_missing");
    return applyMemorySourceMutations(tx, {
      ...input,
      chat,
      hooks: defaultMemorySourceMutationHooks
    });
  });
}

async function settleChat(
  userId: string,
  chatId: string,
  turn: Awaited<ReturnType<typeof createTurn>>
): Promise<void> {
  await mutateSource(userId, chatId, {
    mutations: ["NORMAL_APPEND"],
    patch: { activeLeafMessageId: turn.assistantMessage.id }
  });
  await mutateSource(userId, chatId, {
    mutations: ["TERMINAL_SETTLEMENT"],
    terminalSettlement: {
      assistantMessageId: turn.assistantMessage.id,
      runId: turn.run.id,
      status: "complete"
    }
  });
}

async function claimFactJob(userId: string): Promise<MemoryJobClaim> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { kind: "EXTRACT_FACTS", state: "QUEUED", userId }
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
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    userId: claimed.userId
  };
}

function candidatePlan(
  input: MemoryFactExtractionInput,
  _messageId: string,
  text: string
): MemoryFactExtractionPlan {
  return decodeMemoryFactExtraction([{
    arguments: {
      candidates: [{
        category: "preferences",
        confidence_band: "HIGH",
        correction: false,
        future_useful: true,
        quote: text,
        reason_code: "durable_preference",
        response_preference: text,
        sensitivity: "NORMAL",
        statement: text,
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
  const now = new Date();
  const createdAt = new Date(now.getTime() - 1_000);
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: outputHash,
      completedAt: now,
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
      recoverableUntil: now,
      relationsDetachedAt: now,
      schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
      secretFreeExecutionSnapshot: {},
      startedAt: createdAt,
      state: "SUCCEEDED",
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

async function prepareFactJob(claim: MemoryJobClaim) {
  const prepared = await repository().prepare(claim);
  if ("decision" in prepared) throw new Error(prepared.decision.errorCode);
  return prepared.input;
}

describe("Prisma Memory fact extraction", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits only the settled assistant leaf's direct user parent", async () => {
    const userId = await createOwner("projection");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Independent fact extraction", userId }
      });
      const safe = await createTurn({
        assistantText: "Tea noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T08:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer tea."
      });
      const secret = await createTurn({
        assistantText: "I will not retain credentials.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T08:05:00.000Z"),
        parentMessageId: safe.assistantMessage.id,
        userId,
        userText: "My API key is sk-ABCDEFGHIJKLMNOP1234567890."
      });
      const sensitive = await createTurn({
        assistantText: "Understood.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T08:10:00.000Z"),
        parentMessageId: secret.assistantMessage.id,
        userId,
        userText: "My salary is 100000."
      });
      await settleChat(userId, chat.id, sensitive);

      await expect(prisma.memoryJob.count({
        where: { kind: "EXTRACT_FACTS", userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryJob.count({
        where: { kind: "INDEX_HISTORY", userId }
      })).resolves.toBe(0);

      const claim = await claimFactJob(userId);
      const input = await prepareFactJob(claim);
      expect(input.messages.map(({ id }) => id)).toEqual([sensitive.userMessage.id]);
      expect(input.messages[0]).toMatchObject({
        languageCode: "und",
        text: "My salary is 100000."
      });
      const serialized = JSON.stringify(input);
      expect(serialized).not.toContain("ABCDEFGHIJKLMNOP1234567890");
      expect(serialized).toContain("salary");
      expect(serialized).not.toContain("I prefer tea");
      expect(serialized).not.toContain("Tea noted");
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("persists no candidate or evidence when model output contains a structural secret", async () => {
    const userId = await createOwner("output-secret");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Secret output defense", userId }
      });
      const turn = await createTurn({
        assistantText: "Tea noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T08:30:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer tea."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId);
      const input = await prepareFactJob(claim);
      const plan = decodeMemoryFactExtraction([{
        arguments: {
          candidates: [{
            category: "preferences",
            confidence_band: "HIGH",
            correction: false,
            future_useful: true,
            quote: "I prefer tea.",
            reason_code: "durable_preference",
            response_preference: "tea",
            sensitivity: "NORMAL",
            statement: "API key: sk-abcdefghijklmnopqrstuvwxyz123456",
            temporary: false
          }]
        },
        id: `fact-call-${randomUUID()}`,
        name: MEMORY_FACT_EXTRACTION_TOOL_NAME
      }], input);
      expect(plan.candidates).toEqual([]);
      expect(plan.rejections).toEqual([{
        candidateOrdinal: 0,
        reasonCode: "REJECT_SECRET"
      }]);
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date()
        )
      )).resolves.toBe("APPLIED");
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryCandidateMessage.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it.each(["statement", "quote", "responsePreference", "proposedValue"] as const)(
    "repository independently fences a forged secret in %s",
    async (secretField) => {
    const userId = await createOwner(`forged-${secretField}`);
    try {
      const chat = await prisma.chat.create({
        data: { title: "Forged secret defense", userId }
      });
      const turn = await createTurn({
        assistantText: "Tea noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T08:40:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer tea."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId);
      const input = await prepareFactJob(claim);
      const safePlan = candidatePlan(input, turn.userMessage.id, "I prefer tea.");
      const base = safePlan.candidates[0]!;
      const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
      let forged: MemoryExtractedCandidate;
      if (secretField === "statement") {
        forged = { ...base, displayText: secret, statement: secret };
      } else if (secretField === "quote") {
        forged = {
          ...base,
          evidence: base.evidence.map((evidence) => ({ ...evidence, quote: secret })),
          quote: secret
        };
      } else if (secretField === "responsePreference") {
        forged = {
          ...base,
          proposedValue: { responsePreference: secret, statement: base.statement },
          responsePreference: secret
        };
      } else {
        forged = {
          ...base,
          proposedValue: {
            responsePreference: secret,
            statement: base.statement
          }
        };
      }
      const plan: MemoryFactExtractionPlan = {
        ...safePlan,
        candidates: [forged],
        outputHash: memoryFactExtractionOutputHash(input, [forged])
      };
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date()
        )
      )).resolves.toBe("APPLIED");
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryCandidateMessage.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("persists exact direct-message evidence and source-purges it atomically", async () => {
    const userId = await createOwner("apply-purge");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Fact candidate apply", userId }
      });
      const turn = await createTurn({
        assistantText: "Tea noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T09:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer tea."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId);
      const input = await prepareFactJob(claim);
      const plan = candidatePlan(input, turn.userMessage.id, "I prefer tea.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await prisma.memoryJob.update({
        data: { leaseToken: randomUUID() },
        where: { id: claim.id }
      });
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date()
        )
      )).resolves.toBe("STALE");
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await prisma.memoryJob.update({
        data: {
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseToken: claim.claimToken
        },
        where: { id: claim.id }
      });
      const applied = await withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date()
        )
      );
      expect(applied).toBe("APPLIED");
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: plan.candidates[0]!.id }
      })).resolves.toMatchObject({
        chatId: chat.id,
        proposedCoreEligible: true,
        proposedCoreSalience: "HIGH",
        createdByExecutionId: bindingId,
        jobId: claim.id,
        proposedDisplayText: "I prefer tea.",
        state: "PENDING",
        userId
      });
      await expect(prisma.memoryCandidateMessage.findFirstOrThrow({
        where: { candidateId: plan.candidates[0]!.id, userId }
      })).resolves.toMatchObject({
        chatId: chat.id,
        endOffset: "I prefer tea.".length,
        messageId: turn.userMessage.id,
        sourceTextHash: memorySha256("I prefer tea."),
        startOffset: 0
      });

      await mutateSource(userId, chat.id, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: turn.assistantMessage.id }
      });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: plan.candidates[0]!.id }
      })).resolves.toMatchObject({
        reasonCode: "source_invalidated",
        resolvedAt: expect.any(Date),
        state: "STALE"
      });
      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "SOURCE_PURGE", targetId: chat.id, userId }
      });
      const completedAt = new Date("2026-08-11T09:06:00.000Z");
      await prisma.memoryDeletionOutbox.update({
        data: {
          completedAt,
          lastAuditAt: completedAt,
          state: "SUCCEEDED",
          updatedAt: completedAt
        },
        where: { id: deletion.id }
      });
      const replay = await reconcileCompletedMemoryHistorySourceDeletionAudits(
        prisma,
        { now: new Date("2026-08-11T09:07:00.000Z") }
      );
      expect(replay.reopened).toBeGreaterThanOrEqual(1);
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: deletion.id }
      })).resolves.toMatchObject({
        completedAt: null,
        errorCode: "memory_purge_incomplete",
        state: "PENDING"
      });
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(Date.now() + 60_000);
      const running = await prisma.memoryDeletionOutbox.update({
        data: {
          attemptCount: { increment: 1 },
          leaseExpiresAt,
          leaseToken: claimToken,
          state: "RUNNING"
        },
        where: { id: deletion.id }
      });
      const deletionClaim: MemoryDeletionClaim = {
        admissionAuthorizationId: running.admissionAuthorizationId,
        admittedActiveLeafMessageId: running.admittedActiveLeafMessageId,
        admittedChatSourceRevision: running.admittedChatSourceRevision,
        alsoForgetOriginMemories: running.alsoForgetOriginMemories,
        attemptCount: running.attemptCount,
        claimToken,
        id: running.id,
        leaseExpiresAt,
        memoryGeneration: running.memoryGeneration,
        operation: running.operation,
        recoveredLease: false,
        resumedFromBlocked: false,
        targetId: running.targetId,
        targetType: running.targetType,
        userId: running.userId
      };
      const execution = await memoryHistorySourceDeletionHandler.execute(
        deletionClaim,
        { now: () => new Date(), signal: new AbortController().signal }
      );
      await expect(prisma.$transaction(async (tx) => {
        await execution.apply?.(tx, deletionClaim);
        throw new Error("memory_fact_purge_crash_fixture");
      })).rejects.toThrow("memory_fact_purge_crash_fixture");
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(1);

      await prisma.$transaction(async (tx) => {
        await execution.apply?.(tx, deletionClaim);
      });
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryCandidateMessage.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects an apply raced by a fact suppression without partial candidates", async () => {
    const userId = await createOwner("suppression-race");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Fact suppression race", userId }
      });
      const turn = await createTurn({
        assistantText: "Tea noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T10:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer tea."
      });
      await settleChat(userId, chat.id, turn);
      const claim = await claimFactJob(userId);
      const input = await prepareFactJob(claim);
      const plan = candidatePlan(input, turn.userMessage.id, "I prefer tea.");
      const bindingId = await createSucceededBinding(
        userId,
        claim,
        input.inputHash,
        plan.outputHash
      );
      await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
        createMemorySuppressionInTransaction(tx, settings, keyring, {
          canonicalKey: plan.candidates[0]!.canonicalKey,
          explicitOverrideAllowed: false,
          scope: "FACT",
          suppressionId: randomUUID()
        }));

      const applied = await withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          claim,
          plan,
          bindingId,
          new Date()
        )
      );
      expect(applied).toBe("STALE");
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryCandidateMessage.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("reprocesses unchanged current evidence after branch invalidation without reviving suppressed rows", async () => {
    const userId = await createOwner("branch-reprocess");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Fact candidate branch reprocessing", userId }
      });
      const turn = await createTurn({
        assistantText: "Tea noted.",
        chatId: chat.id,
        createdAt: new Date("2026-08-11T11:00:00.000Z"),
        parentMessageId: null,
        userId,
        userText: "I prefer tea."
      });
      await settleChat(userId, chat.id, turn);
      const firstClaim = await claimFactJob(userId);
      const firstInput = await prepareFactJob(firstClaim);
      const firstPlan = candidatePlan(
        firstInput,
        turn.userMessage.id,
        "I prefer tea."
      );
      const firstBindingId = await createSucceededBinding(
        userId,
        firstClaim,
        firstInput.inputHash,
        firstPlan.outputHash
      );
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          firstClaim,
          firstPlan,
          firstBindingId,
          new Date()
        )
      )).resolves.toBe("APPLIED");

      await mutateSource(userId, chat.id, {
        mutations: ["BRANCH_PATH_CHANGE"],
        patch: { activeLeafMessageId: turn.assistantMessage.id }
      });
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: firstPlan.candidates[0]!.id }
      })).resolves.toMatchObject({
        reasonCode: "source_invalidated",
        state: "STALE"
      });

      await mutateSource(userId, chat.id, {
        mutations: ["TERMINAL_SETTLEMENT"],
        terminalSettlement: {
          assistantMessageId: turn.assistantMessage.id,
          runId: turn.run.id,
          status: "complete"
        }
      });
      const secondClaim = await claimFactJob(userId);
      const secondInput = await prepareFactJob(secondClaim);
      const secondPlan = candidatePlan(
        secondInput,
        turn.userMessage.id,
        "I prefer tea."
      );
      expect(secondPlan.candidates[0]!.id).toBe(firstPlan.candidates[0]!.id);
      const secondBindingId = await createSucceededBinding(
        userId,
        secondClaim,
        secondInput.inputHash,
        secondPlan.outputHash
      );
      await expect(withLockedMemoryTransaction(
        prisma,
        userId,
        (tx, settings) => repository().apply(
          tx,
          settings,
          secondClaim,
          secondPlan,
          secondBindingId,
          new Date()
        )
      )).resolves.toBe("APPLIED");
      await expect(prisma.memoryCandidate.findUniqueOrThrow({
        where: { id: secondPlan.candidates[0]!.id }
      })).resolves.toMatchObject({
        branchGeneration: secondClaim.branchGeneration,
        createdByExecutionId: secondBindingId,
        jobId: secondClaim.id,
        reasonCode: null,
        state: "PENDING"
      });

      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "SOURCE_PURGE", targetId: chat.id, userId }
      });
      const completedAt = new Date("2026-08-11T11:06:00.000Z");
      await prisma.memoryDeletionOutbox.update({
        data: {
          completedAt,
          lastAuditAt: completedAt,
          state: "SUCCEEDED",
          updatedAt: completedAt
        },
        where: { id: deletion.id }
      });
      await reconcileCompletedMemoryHistorySourceDeletionAudits(prisma, {
        now: new Date("2026-08-11T11:07:00.000Z")
      });
      await expect(prisma.memoryDeletionOutbox.findUniqueOrThrow({
        where: { id: deletion.id }
      })).resolves.toMatchObject({ state: "SUCCEEDED" });
      await expect(prisma.memoryCandidate.count({ where: { userId } }))
        .resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });
});
