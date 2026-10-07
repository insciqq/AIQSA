import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaChatRepository } from "./prismaRepository";
import { createPrismaRunRepository } from "../runs/prismaRepository";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(project = false) {
  const userIds = Array.from({ length: 3 }, () => randomUUID());
  const [ownerId, memberId, outsiderId] = userIds as [string, string, string];
  const chatId = randomUUID();
  const projectId = project ? randomUUID() : null;
  cleanups.push(async () => {
    await prisma.chat.deleteMany({ where: { id: chatId } });
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await prisma.user.createMany({ data: userIds.map(id => ({ id, displayName: "Accounting fixture member", status: "active" })) });
  if (projectId) await prisma.project.create({ data: { id: projectId, name: "Accounting fixture Project",
    createdByUserId: ownerId, createdByDisplayName: "Accounting fixture member", grants: { create: [
      { role: "OWNER", userId: ownerId }, { role: "CONTRIBUTOR", userId: memberId }
    ] } } });
  await prisma.chat.create({ data: { id: chatId, title: "Accounting fixture", memoryMode: "EXCLUDED",
    ...(projectId ? { projectId, createdByUserId: ownerId, createdByDisplayName: "Accounting fixture member" } : { userId: ownerId }) } });
  return { chatId, ownerId, memberId, outsiderId, projectId, repository: createPrismaChatRepository(prisma) };
}

describe("authorized all-history chat usage", () => {
  it("keeps branches, regenerated answers and retained auxiliary records in one total", async () => {
    const f = await fixture();
    const question = await prisma.message.create({ data: { chatId: f.chatId, role: "user", status: "complete", content: "Synthetic question" } });
    const answerIds = [randomUUID(), randomUUID()];
    await prisma.message.createMany({ data: answerIds.map(id => ({ id, chatId: f.chatId, role: "assistant", status: "complete",
      parentMessageId: question.id, content: "Synthetic answer" })) });
    const runs = [];
    for (const assistantMessageId of answerIds) runs.push(await prisma.modelRun.create({ data: {
      chatId: f.chatId, userId: f.ownerId, userMessageId: question.id, assistantMessageId,
      provider: "fake", modelId: "accounting-fixture", status: "complete", normalizedRequest: {}
    } }));
    await prisma.chat.update({ where: { id: f.chatId }, data: { activeLeafMessageId: answerIds[0] } });
    const common = { chatId: f.chatId, userId: f.ownerId, provider: "fake", modelId: "accounting-fixture", purpose: "chat_answer" as const,
      inputTokens: 0, outputTokens: 0, usageCompleteness: "COMPLETE" as const, createdAt: new Date("2020-01-01T00:00:00Z") };
    await prisma.usageEvent.createMany({ data: [
      { ...common, modelRunId: runs[0]!.id, totalTokens: 150, estimatedCostMicros: 20_000 },
      { ...common, modelRunId: runs[1]!.id, totalTokens: 250, estimatedCostMicros: 40_000 },
      { ...common, totalTokens: 70, estimatedCostMicros: 3_000 },
      { ...common, visionAnalysis: true, purpose: "chat_vision", providerModelId: "synthetic-vision", totalTokens: 20 },
      { ...common, optionalDecision: true, purpose: "skill_selection", providerModelId: "synthetic-utility", inputTokens: null,
        outputTokens: null, usageCompleteness: "UNAVAILABLE" },
      // A known-zero receipt is independent of image-generation dispatch,
      // whose database authority is exercised by its own writer tests.
      { ...common, modelId: "synthetic-free", totalTokens: 0, estimatedCostMicros: 0 },
      { ...common, chatId: null, totalTokens: 999, estimatedCostMicros: 999_999 }
    ] });
    const before = (await f.repository.getChat({ chatId: f.chatId, userId: f.ownerId }))!.usageStats;
    expect(before).toEqual({ hasCompletedAnswer: true, recordCount: 6, knownCostRecordCount: 4, incompleteRecordCount: 1,
      totalTokens: 490, estimatedCostMicros: 63_000 });
    // A title may settle after the answer and still belongs to this chat.
    await prisma.chatTitleGeneration.create({ data: { runId: runs[0]!.id, chatId: f.chatId, userId: f.ownerId,
      expectedTitle: "Accounting fixture", titleRevision: 0, questionText: "Synthetic question", answerText: "Synthetic answer",
      providerSnapshot: { providerModelId: "synthetic-title", providerFamily: "fake", model: { upstreamModelId: "accounting-fixture" } },
      status: "dispatched", expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.usageEvent.create({ data: { ...common, modelRunId: runs[0]!.id, chatTitleGeneration: true, purpose: "chat_title",
      chatTitleGenerationId: runs[0]!.id, providerModelId: "synthetic-title", totalTokens: 30, estimatedCostMicros: 1000 } });
    const expected = { hasCompletedAnswer: true, titleUsagePending: true, recordCount: 7, knownCostRecordCount: 5, incompleteRecordCount: 1, totalTokens: 520, estimatedCostMicros: 64_000 };
    for (const activeLeafMessageId of answerIds) {
      await prisma.chat.update({ where: { id: f.chatId }, data: { activeLeafMessageId } });
      expect((await f.repository.getChat({ chatId: f.chatId, userId: f.ownerId }))!.usageStats).toEqual(expected);
    }
    const update = await createPrismaRunRepository(prisma).getChatUpdateForRun({ chatId: f.chatId,
      userId: f.ownerId, userMessageId: question.id, assistantMessageId: answerIds[1]! });
    expect(update?.chat.usageStats).toEqual(expected);
    expect(await f.repository.getChat({ chatId: f.chatId, userId: f.outsiderId })).toBeNull();
    await prisma.chat.update({ where: { id: f.chatId }, data: { archived: true } });
    expect((await f.repository.getArchivedChat({ chatId: f.chatId, userId: f.ownerId }))!.usageStats).toEqual(expected);
  });

  it("distinguishes no usage, unknown usage and known zero without recomputing prices", async () => {
    const f = await fixture();
    const read = async () => (await f.repository.getChat({ chatId: f.chatId, userId: f.ownerId }))!.usageStats;
    expect(await read()).toEqual({ hasCompletedAnswer: false, recordCount: 0, knownCostRecordCount: 0, incompleteRecordCount: 0,
      totalTokens: null, estimatedCostMicros: null });
    await prisma.usageEvent.create({ data: { chatId: f.chatId, userId: f.ownerId, provider: "fake", modelId: "unknown",
      purpose: "chat_answer" } });
    expect(await read()).toEqual({ hasCompletedAnswer: false, recordCount: 1, knownCostRecordCount: 0, incompleteRecordCount: 1,
      totalTokens: null, estimatedCostMicros: null });
    await prisma.usageEvent.create({ data: { chatId: f.chatId, userId: f.ownerId, provider: "fake", modelId: "free",
      purpose: "chat_answer", inputTokens: 0, outputTokens: 0, totalTokens: 0, usageCompleteness: "COMPLETE", estimatedCostMicros: 0 } });
    expect(await read()).toEqual({ hasCompletedAnswer: false, recordCount: 2, knownCostRecordCount: 1, incompleteRecordCount: 1,
      totalTokens: 0, estimatedCostMicros: 0 });
  });

  it("shares the whole Project total with current readers across different initiators", async () => {
    const f = await fixture(true);
    await prisma.usageEvent.createMany({ data: [f.ownerId, f.memberId].map((userId, index) => ({
      userId, chatId: f.chatId, projectId: f.projectId, provider: "fake", modelId: "shared-accounting", purpose: "chat_answer" as const,
      inputTokens: 10, outputTokens: 10, totalTokens: 20, usageCompleteness: "COMPLETE", estimatedCostMicros: (index + 1) * 1000
    })) });
    for (const userId of [f.ownerId, f.memberId]) expect((await f.repository.getChat({ chatId: f.chatId, userId }))!.usageStats)
      .toEqual({ hasCompletedAnswer: false, recordCount: 2, knownCostRecordCount: 2, incompleteRecordCount: 0, totalTokens: 40, estimatedCostMicros: 3000 });
    expect(await f.repository.getChat({ chatId: f.chatId, userId: f.outsiderId })).toBeNull();
    await prisma.projectGrant.delete({ where: { projectId_userId: { projectId: f.projectId!, userId: f.memberId } } });
    expect(await f.repository.getChat({ chatId: f.chatId, userId: f.memberId })).toBeNull();
  });

  it("requires a completed answer or an answer attempt across history while retaining pre-answer receipts", async () => {
    const f = await fixture();
    const other = await fixture();
    await prisma.message.create({ data: { chatId: other.chatId, role: "assistant", status: "complete", content: "Another chat's answer" } });
    const question = await prisma.message.create({ data: { chatId: f.chatId, role: "user", status: "complete", content: "Read a synthetic PDF" } });
    const answer = await prisma.message.create({ data: { chatId: f.chatId, parentMessageId: question.id,
      role: "assistant", status: "queued", content: "" } });
    await prisma.chat.update({ where: { id: f.chatId }, data: { activeLeafMessageId: answer.id } });
    const run = await prisma.modelRun.create({ data: { chatId: f.chatId, userId: f.ownerId, userMessageId: question.id,
      assistantMessageId: answer.id, provider: "fake", modelId: "accounting-fixture", status: "queued", normalizedRequest: {} } });
    const receipt = { chatId: f.chatId, userId: f.ownerId, provider: "fake", modelId: "pdf-reader", purpose: "chat_pdf" as const,
      inputTokens: 700, outputTokens: 50, totalTokens: 750, usageCompleteness: "COMPLETE" as const, estimatedCostMicros: 25000 };
    await prisma.usageEvent.createMany({ data: [receipt,
      // A pre-dispatch stage of the answer's own run is not an answer attempt.
      { ...receipt, modelRunId: run.id, optionalDecision: true, purpose: "skill_selection", providerModelId: "synthetic-utility",
        inputTokens: 10, outputTokens: 0, totalTokens: 10, estimatedCostMicros: 1000 }] });
    const read = async () => (await f.repository.getChat({ chatId: f.chatId, userId: f.ownerId }))!.usageStats;
    const expected = { recordCount: 2, knownCostRecordCount: 2, incompleteRecordCount: 0, totalTokens: 760, estimatedCostMicros: 26000 };
    for (const status of ["queued", "streaming", "error", "cancelled"] as const) {
      await prisma.message.update({ where: { id: answer.id }, data: { status } });
      expect(await read()).toEqual({ ...expected, hasCompletedAnswer: false });
    }
    await prisma.message.update({ where: { id: answer.id }, data: { status: "complete", content: "The completed answer" } });
    // Switch to a branch/page containing only a question; eligibility belongs
    // to the whole chat even when the completed answer is not in this page.
    await prisma.chat.update({ where: { id: f.chatId }, data: { activeLeafMessageId: question.id } });
    const detail = (await f.repository.getChat({ chatId: f.chatId, userId: f.ownerId }))!;
    expect(detail.messages.some(item => item.role === "assistant")).toBe(false);
    expect(detail.usageStats).toEqual({ ...expected, hasCompletedAnswer: true });
  });

  it.each(["cancelled", "error"] as const)("shows spending after a %s first answer that incurred answer usage", async (status) => {
    const f = await fixture();
    const question = await prisma.message.create({ data: { chatId: f.chatId, role: "user", status: "complete", content: "Synthetic question" } });
    const answer = await prisma.message.create({ data: { chatId: f.chatId, parentMessageId: question.id,
      role: "assistant", status, content: "" } });
    await prisma.chat.update({ where: { id: f.chatId }, data: { activeLeafMessageId: answer.id } });
    const run = await prisma.modelRun.create({ data: { chatId: f.chatId, userId: f.ownerId, userMessageId: question.id,
      assistantMessageId: answer.id, provider: "fake", modelId: "accounting-fixture", status, normalizedRequest: {} } });
    const read = async () => (await f.repository.getChat({ chatId: f.chatId, userId: f.ownerId }))!.usageStats;
    expect(await read()).toEqual({ hasCompletedAnswer: false, recordCount: 0, knownCostRecordCount: 0, incompleteRecordCount: 0,
      totalTokens: null, estimatedCostMicros: null });
    // Settlement records the answer round the provider already billed, even after Stop.
    await prisma.usageEvent.create({ data: { chatId: f.chatId, userId: f.ownerId, modelRunId: run.id, provider: "fake",
      modelId: "accounting-fixture", purpose: "chat_answer", inputTokens: 900, outputTokens: 40, totalTokens: 940, usageCompleteness: "COMPLETE",
      estimatedCostMicros: 12000 } });
    expect(await read()).toEqual({ hasCompletedAnswer: true, recordCount: 1, knownCostRecordCount: 1, incompleteRecordCount: 0,
      totalTokens: 940, estimatedCostMicros: 12000 });
  });
});
