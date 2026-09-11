import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { chatTitleWork } from "@/tests/support/chatTitles";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaMemoryMutationAuthorizationRepository } from "../memory/persistence/authorizations";
import { createPrismaPermanentChatDeletionRepository } from "./permanentDeletion/repository";
import { createPermanentChatDeletionService } from "./permanentDeletion/service";
import { createChatTitleRepository } from "./titleGenerationRepository";
import { loadChatTitleFirstTurn } from "./titleGeneration";

const repository = createChatTitleRepository(prisma);
const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 };
afterAll(() => prisma.$disconnect());

async function fixture(run: (work: ReturnType<typeof chatTitleWork>, userMessageId: string) => Promise<void>) {
  const userId = randomUUID();
  const connectionId = randomUUID();
  await prisma.user.create({ data: { id: userId, displayName: "Synthetic title owner", status: "active" } });
  await prisma.providerConnection.create({ data: { id: connectionId, displayName: "Synthetic titles", family: "openai_compatible" } });
  try {
    const credential = await prisma.providerCredential.create({ data: { connectionId, label: "Title test credential" } });
    const version = await prisma.providerCredentialVersion.create({ data: {
      credentialId: credential.id, version: 1, testedAt: new Date(), activatedAt: new Date(), secretEnvelope: null, testEvidence: { authenticationMode: "none" }
    } });
    const model = await prisma.providerModel.create({ data: {
      connectionId, displayName: "Title fixture", provider: "openai_compatible", modelId: "title-test", capabilities: {}, defaultParams: {},
      inputTokenPriceMicros: 1_000_000, outputTokenPriceMicros: 2_000_000
    } });
    const base = chatTitleWork();
    const chat = await prisma.chat.create({ data: { userId, title: base.expectedTitle } });
    const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: textMessageContent(base.questionText) } });
    const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", content: textMessageContent(base.answerText) } });
    const modelRun = await prisma.modelRun.create({ data: {
      chatId: chat.id, userId, userMessageId: question.id, assistantMessageId: answer.id,
      provider: "fake-answer", modelId: "answer-test", normalizedRequest: {}, status: "complete", inputTokens: 20, outputTokens: 30, totalTokens: 50
    } });
    await run(chatTitleWork({ chatId: chat.id, runId: modelRun.id, userId, providerSnapshot: {
      ...base.providerSnapshot, connectionId, credentialId: credential.id, credentialVersionId: version.id, providerModelId: model.id,
      providerFamily: "openai_compatible",
      model: { ...base.providerSnapshot.model, adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer" },
      connection: { ...base.providerSnapshot.connection, allowPrivateNetwork: true,
        apiRoot: "http://127.0.0.1:43210", authenticationMode: "none" }
    } }), question.id);
  } finally {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credential: { connectionId } } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.delete({ where: { id: connectionId } });
  }
}

const expiry = () => new Date(Date.now() + 300_000);
const chat = (id: string) => prisma.chat.findUniqueOrThrow({ where: { id } });
const job = (runId: string) => prisma.chatTitleGeneration.findUniqueOrThrow({ where: { runId } });

async function fenceDeletion(work: ReturnType<typeof chatTitleWork>) {
  const service = createPermanentChatDeletionService({
    authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
    capability: { enabled: true }, kick: () => undefined,
    repository: createPrismaPermanentChatDeletionRepository(prisma)
  });
  const before = await chat(work.chatId);
  const request = { alsoForgetOriginMemories: false, expectedActiveLeafMessageId: before.activeLeafMessageId,
    expectedChatRevision: before.memorySourceRevision };
  const authorization = await service.mintAuthorization(work.userId, work.chatId, {
    ...request, confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestNonce: randomUUID()
  });
  await service.admit(work.userId, work.chatId, { ...request, mutationAuthorizationId: authorization.mutationAuthorizationId });
}

describe("durable optional title work", () => {
  it("claims once across workers, survives a second turn and enriches only the original run once", async () => {
    await fixture(async (work, userMessageId) => {
      expect(await loadChatTitleFirstTurn(prisma, { ...work, userMessageId })).toMatchObject({ titleRevision: 0 });
      await Promise.all([repository.enqueue(work, expiry()), repository.enqueue(work, expiry())]);
      const second = await prisma.message.create({ data: { chatId: work.chatId, role: "user", content: textMessageContent("A second question") } });
      const secondRun = await prisma.modelRun.create({ data: { chatId: work.chatId, userId: work.userId,
        userMessageId: second.id, provider: "fake-answer", modelId: "answer-test", normalizedRequest: {}, status: "complete" } });
      expect(await loadChatTitleFirstTurn(prisma, { ...work, userMessageId: second.id })).toBeNull();
      await repository.enqueue({ ...work, runId: secondRun.id }, expiry());
      expect(await prisma.chatTitleGeneration.count({ where: { chatId: work.chatId } })).toBe(1);
      const taken = await Promise.all([repository.take(new Date()), repository.take(new Date())]);
      expect(taken.filter((value) => value !== null)).toHaveLength(1);
      expect(taken.find((value) => value !== null)).toMatchObject({ runId: work.runId, providerSnapshot: {
        connectionId: work.providerSnapshot.connectionId, connection: work.providerSnapshot.connection,
        credentialId: work.providerSnapshot.credentialId, credentialVersionId: work.providerSnapshot.credentialVersionId,
        providerFamily: work.providerSnapshot.providerFamily, providerModelId: work.providerSnapshot.providerModelId,
        model: { upstreamModelId: work.providerSnapshot.model.upstreamModelId }
      } });
      expect(await prisma.usageEvent.findUnique({ where: { chatTitleGenerationId: work.runId } })).toMatchObject({
        inputTokens: null, totalTokens: null, estimatedCostMicros: null, provider: "openai_compatible", modelId: "title-test"
      });
      await expect(prisma.usageEvent.create({ data: {
        chatId: work.chatId, chatTitleGeneration: true, chatTitleGenerationId: work.runId,
        modelRunId: work.runId, userId: work.userId, provider: "openai_compatible", modelId: "title-test",
        providerModelId: "unrelated-model"
      } })).rejects.toThrow("chat_title_usage_scope_invalid");
      await Promise.all([repository.recordUsage(work, usage), repository.recordUsage(work, usage)]);
      await Promise.all([repository.finish(work, "TCP and UDP compared"), repository.finish(work, "TCP and UDP compared")]);
      expect((await chat(work.chatId)).title).toBe("TCP and UDP compared");
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: work.runId } })).toMatchObject({ status: "complete", inputTokens: 30, outputTokens: 35, totalTokens: 65 });
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: secondRun.id } })).toMatchObject({ totalTokens: 0 });
      expect(await prisma.usageEvent.count({ where: { chatTitleGenerationId: work.runId } })).toBe(1);
      expect(await job(work.runId)).toMatchObject({ status: "settled", providerSnapshot: null, answerText: "", questionText: "" });
      const receipt = await prisma.usageEvent.findUniqueOrThrow({ where: { chatTitleGenerationId: work.runId } });
      await expect(prisma.usageEvent.update({ where: { id: receipt.id }, data: { totalTokens: 99 } }))
        .rejects.toThrow("chat_title_usage_immutable");
      await prisma.chatTitleGeneration.delete({ where: { runId: work.runId } });
      expect(await prisma.usageEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
        chatTitleGeneration: true, chatTitleGenerationId: null, totalTokens: 15
      });
    });
  });

  it.each(["rename", "archive", "delete", "revoke"] as const)("preserves paid accounting when %s prevents applying the title", async (change) => {
    await fixture(async (work) => {
      await repository.enqueue(work, expiry());
      expect(await repository.take(new Date())).toMatchObject({ runId: work.runId });
      if (change === "revoke") await prisma.providerCredentialVersion.update({ where: { id: work.providerSnapshot.credentialVersionId! }, data: { revokedAt: new Date() } });
      else if (change === "delete") await fenceDeletion(work);
      else await prisma.chat.update({ where: { id: work.chatId }, data: change === "rename"
        ? { title: work.expectedTitle, titleRevision: { increment: 1 } }
        : { archived: true } });
      await repository.recordUsage(work, usage);
      await repository.finish(work, "A late name");
      expect((await chat(work.chatId)).title).toBe(work.expectedTitle);
      expect(await prisma.usageEvent.findUniqueOrThrow({ where: { chatTitleGenerationId: work.runId } })).toMatchObject({ totalTokens: 15 });
      expect(await job(work.runId)).toMatchObject({ status: "settled", providerSnapshot: null });
    });
  });

  it("never replays an ambiguous dispatch and never dispatches a cancelled or expired pending job", async () => {
    await fixture(async (work) => {
      await repository.enqueue(work, expiry());
      expect(await repository.take(new Date())).toMatchObject({ runId: work.runId });
      await repository.recover(new Date(Date.now() + 61_000));
      expect(await repository.take(new Date())).toBeNull();
      expect(await job(work.runId)).toMatchObject({ status: "ambiguous", providerSnapshot: null });
      expect(await prisma.usageEvent.findUniqueOrThrow({ where: { chatTitleGenerationId: work.runId } })).toMatchObject({ totalTokens: null });
    });
    for (const status of ["in_progress", "cancelled"] as const) await fixture(async (work) => {
      await prisma.modelRun.update({ where: { id: work.runId }, data: { status } });
      await repository.enqueue(work, expiry());
      expect(await repository.take(new Date())).toBeNull();
      await repository.recover(new Date(Date.now() + 301_000));
      expect(await job(work.runId)).toMatchObject({ status: "skipped", providerSnapshot: null });
      expect(await prisma.usageEvent.count({ where: { chatTitleGenerationId: work.runId } })).toBe(0);
    });
  });
});
