import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { makeContextCompactionStatus } from "../../contracts/contextCompaction";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { createNativeRunStore } from "./runStore";
import type { TranscriptItem } from "./transcript";

const owners: string[] = [];
const store = createNativeRunStore(prisma);

async function nativeRun(engine: "native" | "v1" = "native", status: "cancelled" | "streaming" = "streaming") {
  const userId = `native-run-store-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Native run store test", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } } } });
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
    title: "Native", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Q"), role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id,
    role: "assistant", status: status === "streaming" ? "streaming" : "cancelled" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  // Only a preparing run lacks its normalized request (ModelRun_memory_request_shape_check).
  const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine, modelId: "fake-qsa",
    normalizedRequest: {}, provider: "fake", status, userId, userMessageId: question.id } });
  return { assistantMessageId: answer.id, chatId: chat.id, runId: run.id, userId };
}

const call = (inputTokens: number): RunUsageAttribution => ({ estimatedCostMicros: 5, modelId: "fake-qsa", operationCount: 1,
  provider: "fake", purpose: "chat_answer", usage: { inputTokens, outputTokens: 2 } });

const compactionItem = (): TranscriptItem => ({ id: randomUUID(), keepFromId: "msg-1", kind: "compaction",
  origin: { model: "fake-qsa", provider: "fake" }, retained: "Kept.", summary: "## Summary\n- facts" });
const marker = makeContextCompactionStatus({ afterTokens: 10, beforeTokens: 100, cycle: 1, outcome: "summary_applied", state: "complete" });

/** The deletion fence as admission writes it: a durable operation, then the chat leaves the live key space. */
async function fence(tx: Prisma.TransactionClient, chatId: string, userId: string): Promise<void> {
  const chat = await tx.chat.findUniqueOrThrow({ select: { memorySourceRevision: true }, where: { id: chatId } });
  const deletionId = randomUUID();
  await tx.memoryDeletionOutbox.create({ data: { admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: chat.memorySourceRevision,
    alsoForgetOriginMemories: false, id: deletionId, memoryGeneration: 0, operation: "SOURCE_PURGE", targetId: chatId,
    targetType: "CHAT@memory-chat-delete-v1", userId } });
  await tx.chat.update({ data: { archived: true, permanentDeletionAt: new Date(), permanentDeletionOperationId: deletionId },
    where: { id: chatId } });
}

async function recordedCompactions(runId: string) {
  return {
    events: await prisma.modelRunEvent.count({ where: { eventType: "artifact", modelRunId: runId,
      payload: { equals: "context_compaction", path: ["artifactType"] } } }),
    items: await prisma.runTranscriptItem.count({ where: { kind: "compaction", modelRunId: runId } })
  };
}

afterEach(async () => {
  for (const id of owners.splice(0)) {
    // The deletion fence leaves its durable operation, which the fenced chat references and which restricts
    // deleting the owner: chats first, then the operation, then the owner.
    await prisma.chat.deleteMany({ where: { userId: id } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
afterAll(() => prisma.$disconnect());

describe("native run store", () => {
  it("publishes the answer once, then completes the run and closes its open calls with an unknown outcome", async () => {
    const scope = await nativeRun();
    await expect(store.publishAnswer(scope, { followupRevision: 0, text: "The answer." })).resolves.toBe(true);
    await expect(store.publishAnswer(scope, { followupRevision: 0, text: "Again." })).resolves.toBe(false);
    await expect(prisma.message.findUniqueOrThrow({ where: { id: scope.assistantMessageId } })).resolves
      .toMatchObject({ content: textMessageContent("The answer."), status: "complete" });
    const open = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: scope.runId, ordinal: 0,
      providerCallId: "call-1", roundIndex: 1, startedAt: new Date(), state: "running", toolName: "workspace_shell" } });
    await expect(store.complete(scope)).resolves.toBe(true);
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: scope.runId } })).resolves
      .toMatchObject({ engine: "native", status: "complete" });
    await expect(prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: open.id } })).resolves.toMatchObject({ state: "error" });
  });

  it("measures the whole run to its published answer, as a reload reads it", async () => {
    const scope = await nativeRun();
    await expect(store.workDurationMs(scope)).resolves.toBeNull();
    await expect(store.publishAnswer(scope, { followupRevision: 0, text: "Done." })).resolves.toBe(true);
    const run = await prisma.modelRun.findUniqueOrThrow({ select: { answerCompletedAt: true, createdAt: true }, where: { id: scope.runId } });
    await expect(store.workDurationMs(scope)).resolves.toBe(run.answerCompletedAt!.getTime() - run.createdAt.getTime());
    await expect(store.workDurationMs({ ...scope, userId: "someone-else" })).resolves.toBeNull();
  });

  it("publishes nothing for a stopped run or a run of the old core", async () => {
    await expect(store.publishAnswer(await nativeRun("native", "cancelled"), { followupRevision: 0, text: "x" })).resolves.toBe(false);
    await expect(store.publishAnswer(await nativeRun("v1"), { followupRevision: 0, text: "x" })).resolves.toBe(false);
  });

  it("keeps the streamed text with a stopped answer, and writes no other answer", async () => {
    const stopped = await nativeRun("native", "cancelled");
    await expect(store.saveStoppedText(stopped, "Partial text")).resolves.toBe(true);
    await expect(prisma.message.findUniqueOrThrow({ where: { id: stopped.assistantMessageId } })).resolves
      .toMatchObject({ content: textMessageContent("Partial text"), status: "cancelled" });
    await expect(store.saveStoppedText(await nativeRun(), "x")).resolves.toBe(false);
    await expect(store.saveStoppedText(await nativeRun("v1", "cancelled"), "x")).resolves.toBe(false);
  });

  it("writes each call's usage once and the totals once, however often the write repeats", async () => {
    const scope = await nativeRun();
    const rows = [{ attribution: call(10), key: "0" }, { attribution: call(20), key: "1" }];
    await store.writeUsageRows(scope, rows);
    await store.writeUsageRows(scope, rows);
    await expect(prisma.usageEvent.count({ where: { modelRunId: scope.runId } })).resolves.toBe(2);
    await store.applyUsageTotals(scope, [call(10), call(20)]);
    await store.applyUsageTotals(scope, [call(10), call(20)]);
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: scope.runId } })).resolves
      .toMatchObject({ inputTokens: 30, outputTokens: 4 });
    await expect(prisma.chat.findUniqueOrThrow({ where: { id: scope.chatId } })).resolves
      .toMatchObject({ totalInputTokens: 30, totalOutputTokens: 4 });
  });

  it("records a compaction that finished after its run with its marker, once, on that run only", async () => {
    const scope = await nativeRun("native", "cancelled");
    const item = compactionItem();
    await expect(store.recordDetachedCompaction(scope, { item, sequence: 3, status: marker })).resolves.toBe(true);
    // A write repeated after its outcome was lost finds its item and adds nothing.
    await expect(store.recordDetachedCompaction(scope, { item, sequence: 4, status: marker })).resolves.toBe(true);
    await expect(recordedCompactions(scope.runId)).resolves.toEqual({ events: 1, items: 1 });
    await expect(prisma.runTranscriptItem.findUniqueOrThrow({ where: { id: item.id } })).resolves.toMatchObject({ sequence: 3 });
    // Another owner, another chat or a run of the old core takes nothing.
    const other = await nativeRun();
    await expect(store.recordDetachedCompaction({ ...scope, userId: other.userId }, { item: compactionItem(), sequence: 5, status: marker }))
      .resolves.toBe(false);
    await expect(store.recordDetachedCompaction({ ...scope, chatId: other.chatId }, { item: compactionItem(), sequence: 5, status: marker }))
      .resolves.toBe(false);
    const old = await nativeRun("v1");
    await expect(store.recordDetachedCompaction(old, { item: compactionItem(), sequence: 0, status: marker })).resolves.toBe(false);
    await expect(recordedCompactions(old.runId)).resolves.toEqual({ events: 0, items: 0 });
  });

  it("writes nothing once the chat is fenced for deletion, also when the fence commits while the write waits for the chat", async () => {
    const fenced = await nativeRun("native", "cancelled");
    await prisma.$transaction(async (tx) => fence(tx, fenced.chatId, fenced.userId));
    await expect(store.recordDetachedCompaction(fenced, { item: compactionItem(), sequence: 0, status: marker })).resolves.toBe(false);
    await expect(recordedCompactions(fenced.runId)).resolves.toEqual({ events: 0, items: 0 });

    const racing = await nativeRun("native", "cancelled");
    const pending: { write?: Promise<boolean> } = {};
    await prisma.$transaction(async (tx) => {
      // Deletion admission holds the chat row while it fences; the write queues behind it and then sees the fence.
      await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${racing.chatId} FOR UPDATE`;
      pending.write = store.recordDetachedCompaction(racing, { item: compactionItem(), sequence: 0, status: marker });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await fence(tx, racing.chatId, racing.userId);
    });
    await expect(pending.write).resolves.toBe(false);
    await expect(recordedCompactions(racing.runId)).resolves.toEqual({ events: 0, items: 0 });
  });
});
