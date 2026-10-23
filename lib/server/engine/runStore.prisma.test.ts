import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import type { RunUsageAttribution } from "../runs/runRepositoryContract";
import { createNativeRunStore } from "./runStore";

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

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
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
});
