import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaMessageBranchRepository } from "./prismaRepository";

async function createMessage(chatId: string, parentMessageId: string | null = null) {
  return prisma.message.create({
    data: {
      chatId,
      content: textMessageContent("Synthetic Memory source"),
      parentMessageId,
      role: parentMessageId === null ? "user" : "assistant",
      status: "complete"
    }
  });
}

async function createJobUsage(input: Readonly<{
  activeLeafMessageId: string;
  chatId: string;
  sourceMessageId: string;
  userId: string;
}>) {
  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + 1);
  return prisma.$transaction(async (tx) => {
    const settings = await tx.userMemorySettings.findUniqueOrThrow({
      where: { userId: input.userId }
    });
    const job = await tx.memoryJob.create({
      data: {
        ...input,
        branchGeneration: 0,
        completedAt,
        createdAt: startedAt,
        idempotencyFingerprint: randomUUID(),
        kind: "EXTRACT_FACTS",
        memoryGenerationSnapshot: settings.memoryGeneration,
        memoryRevisionSnapshot: settings.memoryRevision,
        pipelineVersion: "message-delete-fixture-v1",
        sourceHash: "message-delete-source",
        sourceRevision: 0,
        state: "SUCCEEDED"
      }
    });
    // Settled, provider-detached calls still carry the restrictive usage FK.
    const binding = await tx.memoryExecutionBinding.create({
      data: {
        completedAt,
        createdAt: startedAt,
        destinationFingerprint: "message-delete-destination",
        inputHash: "message-delete-input",
        logicalRole: "MEMORY_EXTRACT",
        memoryJobId: job.id,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: "message-delete-fixture-v1",
        policyVersion: "message-delete-policy-v1",
        promptVersion: "message-delete-prompt-v1",
        providerId: "message-delete-fixture",
        recoverableUntil: completedAt,
        relationsDetachedAt: completedAt,
        schemaVersion: "message-delete-schema-v1",
        secretFreeExecutionSnapshot: {},
        startedAt,
        state: "SUCCEEDED",
        userId: input.userId
      }
    });
    const usage = await tx.usageEvent.create({
      data: {
        cachedInputTokens: 2,
        estimatedCostMicros: 37,
        inputTokens: 11,
        memoryExecutionBindingId: binding.id,
        modelId: "message-delete-model",
        outputTokens: 5,
        provider: "message-delete-fixture",
        providerModelId: "message-delete-model-v1",
        purpose: "memory_indexing",
        reasoningTokens: 1,
        totalTokens: 16,
        usageCompleteness: "COMPLETE",
        userId: input.userId
      }
    });
    return { binding, job, usage };
  });
}

describe("message deletion Memory accounting", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("retains usage while deleting jobs by source message or active leaf, leaving unrelated usage attached", async () => {
    const userId = `message-memory-delete-${randomUUID()}`;
    const otherUserId = `message-memory-delete-other-${randomUUID()}`;
    const userIds = [userId, otherUserId];
    try {
      for (const id of userIds) {
        await prisma.user.create({ data: { displayName: "Memory deletion test", id, status: "active" } });
      }
      const chat = await prisma.chat.create({ data: { title: "Memory source", userId } });
      const removed = await createMessage(chat.id);
      const child = await createMessage(chat.id, removed.id);
      const kept = await createMessage(chat.id);
      await prisma.chat.update({ data: { activeLeafMessageId: kept.id }, where: { id: chat.id } });

      const byLeaf = await createJobUsage({
        activeLeafMessageId: child.id, chatId: chat.id, sourceMessageId: kept.id, userId
      });
      const bySource = await createJobUsage({
        activeLeafMessageId: kept.id, chatId: chat.id, sourceMessageId: removed.id, userId
      });
      const unrelated = [await createJobUsage({
        activeLeafMessageId: kept.id, chatId: chat.id, sourceMessageId: kept.id, userId
      })];
      for (const ownerId of userIds) {
        const otherChat = await prisma.chat.create({ data: { title: "Unrelated Memory source", userId: ownerId } });
        const message = await createMessage(otherChat.id);
        unrelated.push(await createJobUsage({
          activeLeafMessageId: message.id, chatId: otherChat.id, sourceMessageId: message.id, userId: ownerId
        }));
      }
      const repository = createPrismaMessageBranchRepository(prisma);
      await expect(repository.deleteMessageSubtree({ messageId: removed.id, userId: otherUserId }))
        .resolves.toBeNull();
      await expect(prisma.usageEvent.findUniqueOrThrow({ where: { id: bySource.usage.id } }))
        .resolves.toEqual(bySource.usage);

      // Before the fix, the job cascade fails with PostgreSQL 23001 here.
      await expect(repository.deleteMessageSubtree({ messageId: removed.id, userId }))
        .resolves.toMatchObject({
          activeLeafMessageId: kept.id,
          chatId: chat.id,
          deletedMessageIds: expect.arrayContaining([removed.id, child.id])
        });
      await expect(prisma.message.count({ where: { id: { in: [removed.id, child.id] } } }))
        .resolves.toBe(0);
      await expect(prisma.message.findUnique({ where: { id: kept.id } })).resolves.not.toBeNull();
      for (const { binding, job, usage } of [byLeaf, bySource]) {
        await expect(prisma.memoryJob.findUnique({ where: { id: job.id } })).resolves.toBeNull();
        await expect(prisma.memoryExecutionBinding.findUnique({ where: { id: binding.id } })).resolves.toBeNull();
        await expect(prisma.usageEvent.findUniqueOrThrow({ where: { id: usage.id } }))
          .resolves.toEqual({ ...usage, memoryExecutionBindingId: null, providerModelId: null });
      }
      for (const { binding, job, usage } of unrelated) {
        await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } })).resolves.toEqual(job);
        await expect(prisma.memoryExecutionBinding.findUniqueOrThrow({ where: { id: binding.id } }))
          .resolves.toEqual(binding);
        await expect(prisma.usageEvent.findUniqueOrThrow({ where: { id: usage.id } })).resolves.toEqual(usage);
      }
      await expect(repository.deleteMessageSubtree({ messageId: removed.id, userId })).resolves.toBeNull();
      await expect(prisma.usageEvent.count({ where: { userId: { in: userIds } } })).resolves.toBe(5);
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.usageEvent.deleteMany({ where: { userId: { in: userIds } } });
        await tx.memoryJob.deleteMany({ where: { userId: { in: userIds } } });
        await tx.chat.deleteMany({ where: { userId: { in: userIds } } });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      });
    }
  });
});
