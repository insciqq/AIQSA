import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { textMessageContent } from "../../../domain/content";
import { assistantAvatarRecipeFromBytes } from "../../../contracts/assistants";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { createPrismaAssistantDeletionRepository } from "../../assistants/deletionRepository";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { requireMemoryCommandSource } from "./sourceAuthority";

async function fixture(withAssistant = false) {
  const userId = `command-source-${randomUUID()}`;
  const cleanup = async () => {
    await prisma.memoryOperationReceipt.deleteMany({ where: { userId } });
    await prisma.memoryMutationAuthorization.deleteMany({ where: { userId } });
    await prisma.memoryExecutionBinding.deleteMany({ where: { userId } });
    await prisma.memoryJob.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.assistantDefinition.deleteMany({ where: { ownerUserId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  };
  try {
    await prisma.user.create({ data: { id: userId, displayName: "Synthetic command", status: "active" } });
    const assistant = withAssistant ? await prisma.assistantDefinition.create({ data: {
      ownerUserId: userId, name: "Synthetic command Assistant",
      avatar: assistantAvatarRecipeFromBytes(new Uint8Array(10)),
      providerModelId: providerTemplateIds.fakeModel, systemPrompt: "Answer directly.", searchPlan: { mode: "off" }
    } }) : null;
    const chat = await prisma.chat.create({ data: { userId, title: "Synthetic command source",
      ...(assistant ? { assistantId: assistant.id } : {}) } });
    const message = await prisma.message.create({ data: { chatId: chat.id, role: "user",
      content: textMessageContent("Remember that my synthetic preference is green"), status: "complete" } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", parentMessageId: message.id,
      content: textMessageContent("I will try"), status: "complete" } });
    const run = await prisma.modelRun.create({ data: { chatId: chat.id, userId,
      ...(assistant ? { assistantId: assistant.id, assistantIdentity: { name: assistant.name, avatar: assistant.avatar } } : {}),
      userMessageId: message.id, assistantMessageId: answer.id, provider: "fake", modelId: "fake", normalizedRequest: {}, status: "complete" } });
    await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: answer.id } });
    const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
    const claimToken = randomUUID();
    const job = await prisma.memoryJob.create({ data: {
      userId, chatId: chat.id, sourceMessageId: message.id, activeLeafMessageId: answer.id,
      branchGeneration: 0, sourceRevision: 0, sourceHash: memorySha256(message.content),
      kind: "MEMORY_COMMAND", state: "CLAIMED", leaseToken: claimToken,
      leaseExpiresAt: new Date(Date.now() + 120_000), commandSequence: 1, commandStatus: "RUNNING", commandOperation: "UNKNOWN",
      memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision,
      idempotencyFingerprint: randomUUID(), pipelineVersion: "memory-command-v1"
    } });
    return { userId, chat, message, answer, run, job, assistant,
      check: () => withLockedMemoryTransaction(prisma, userId, (tx) => requireMemoryCommandSource(tx, userId, job.id, claimToken)),
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

describe("Memory command exact source authority", () => {
  afterAll(() => prisma.$disconnect());
  it("rejects a pending command when deletion detaches its accepted Assistant", async () => {
    const f = await fixture(true);
    try {
      if (!f.assistant) throw new Error("assistant_fixture_missing");
      expect(await f.check()).toMatchObject({ modelRunId: f.run.id });
      await expect(createPrismaAssistantDeletionRepository(prisma).delete(
        f.userId, f.assistant.id, f.assistant.version
      )).resolves.toEqual({ kind: "deleted" });
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: f.run.id },
        select: { assistantId: true, assistantIdentity: true } })).toEqual({
        assistantId: null, assistantIdentity: f.run.assistantIdentity
      });
      await expect(f.check()).rejects.toThrow("memory_mutation_authorization_invalid");
    } finally { await f.cleanup(); }
  });

  it("survives a completed answer and ordinary descendant append but rejects a changed branch", async () => {
    const f = await fixture();
    try {
      expect(await f.check()).toMatchObject({ modelRunId: f.run.id });
      const next = await prisma.message.create({ data: { chatId: f.chat.id, role: "user", parentMessageId: f.answer.id,
        content: textMessageContent("A subsequent ordinary message"), status: "complete" } });
      await prisma.chat.update({ where: { id: f.chat.id }, data: { activeLeafMessageId: next.id, memorySourceRevision: { increment: 1 } } });
      expect(await f.check()).toMatchObject({ modelRunId: f.run.id });
      await prisma.chat.update({ where: { id: f.chat.id }, data: { memoryBranchGeneration: { increment: 1 } } });
      await expect(f.check()).rejects.toThrow("memory_mutation_authorization_invalid");
    } finally { await f.cleanup(); }
  });
  it("rejects a generation change while the classifier is in flight", async () => {
    const f = await fixture();
    try {
      await prisma.userMemorySettings.update({ where: { userId: f.userId }, data: { memoryGeneration: { increment: 1 } } });
      await expect(f.check()).rejects.toThrow("memory_mutation_authorization_invalid");
    } finally { await f.cleanup(); }
  });
  it("rejects source replacement and an expired lease", async () => {
    const f = await fixture();
    try {
      await prisma.message.update({ where: { id: f.message.id }, data: { content: textMessageContent("Changed source") } });
      await expect(f.check()).rejects.toThrow("memory_mutation_authorization_invalid");
      await prisma.message.update({ where: { id: f.message.id }, data: { content: f.message.content! } });
      await prisma.memoryJob.update({ where: { id: f.job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
      await expect(f.check()).rejects.toThrow("memory_mutation_authorization_invalid");
    } finally { await f.cleanup(); }
  });
});
