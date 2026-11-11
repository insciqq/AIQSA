import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "./prismaRepository";
import type { RunRepository } from "./runRepositoryContract";

/**
 * A message the owner writes in a monitoring automation's chat continues the
 * latest turn they were shown, never a quiet check its history leaves out,
 * and its model reads that same branch (operator decision 2026-11-11).
 */
const owners: string[] = [];
const repository = createPrismaRunRepository(prisma);
afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    await tx.user.deleteMany({ where: { id } });
  });
});
afterAll(() => prisma.$disconnect());

async function owner(): Promise<string> {
  const userId = `quiet-check-send-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: {
    displayName: "Quiet check send test", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } }
  } });
  return userId;
}

function sendInput(chatId: string, userId: string, expectedActiveLeafId: string | null): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("What changed since the last result?");
  return {
    chatId, content, expectedActiveLeafId, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, userId,
    normalizedRequest: {
      attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
    }
  };
}

/** A task chat of checks with these outcomes, each a scheduled turn, its answer and the run that settled it. */
async function taskChat(userId: string, outcomes: readonly (string | null)[]) {
  const { id: chatId } = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Watch", userId } });
  const checks: Array<{ answerId: string; questionId: string }> = [];
  let parentMessageId: string | null = null;
  for (const [index, outcome] of outcomes.entries()) {
    const at = new Date(Date.UTC(2026, 10, 2, index));
    const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Check the release page"), createdAt: at,
      parentMessageId, role: "user", scheduledTaskPrompt: true, status: "complete" } });
    const answer = await prisma.message.create({ data: { chatId, content: textMessageContent(outcome === "no_update" ? "" : "Version 1.0"),
      createdAt: at, parentMessageId: question.id, role: "assistant", status: "complete" } });
    await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, createdAt: at, modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", scheduledOccurrenceId: randomUUID(), scheduledOutcome: outcome, scheduledTaskGeneration: 1,
      scheduledTaskId: randomUUID(), status: "complete", userId, userMessageId: question.id } });
    checks.push({ answerId: answer.id, questionId: question.id });
    parentMessageId = answer.id;
  }
  await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chatId } });
  return { chatId, checks, leaf: parentMessageId! };
}

describe("a message after quiet checks", () => {
  it("continues the latest shown result, reads that branch, and opens after it", async () => {
    const userId = await owner();
    const { chatId, checks, leaf } = await taskChat(userId, ["baseline", "no_update", "no_update"]);
    const shown = checks[0]!;
    // The browser names the result it was shown; the stored leaf reads as it.
    expect(await repository.loadVisibleLeafMessageId?.(chatId, leaf)).toBe(shown.answerId);
    expect(await repository.loadVisibleLeafMessageId?.(chatId, shown.answerId)).toBe(shown.answerId);
    expect((await repository.loadConversationContextForExpectedLeaf(chatId, userId, leaf))?.map((message) => message.id))
      .toEqual([shown.questionId, shown.answerId]);

    const created = await repository.createRun(sendInput(chatId, userId, leaf));
    const question = await prisma.message.findUniqueOrThrow({ select: { parentMessageId: true }, where: { id: created.userMessageId } });
    expect(question.parentMessageId).toBe(shown.answerId);
    expect((await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chatId } })).activeLeafMessageId)
      .toBe(created.assistantMessageId);
    const update = await repository.getChatUpdateForRun({ assistantMessageId: created.assistantMessageId, chatId, userId,
      userMessageId: created.userMessageId });
    expect(update?.messages.find((message) => message.id === created.userMessageId)?.parentMessageId).toBe(shown.answerId);

    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail!.messages.map((message) => message.id))
      .toEqual([shown.questionId, shown.answerId, created.userMessageId, created.assistantMessageId]);
    // The quiet checks left the branch with no visible fork.
    const graph = await createPrismaChatRepository(prisma).getBranches({ chatId, userId });
    expect(graph!.nodes.map((node) => node.id)).toEqual([shown.questionId, shown.answerId, created.userMessageId, created.assistantMessageId]);
  });

  it("regenerates the latest shown result although quiet checks follow it", async () => {
    const userId = await owner();
    const { chatId, checks } = await taskChat(userId, ["baseline", "no_update", "no_update"]);
    const shown = checks[0]!;
    const send = sendInput(chatId, userId, null);
    const content = textMessageContent("Check the release page");
    const regenerated = await repository.createRegenerationRun({ chatId, modelId: send.modelId,
      normalizedRequest: { ...send.normalizedRequest, content }, preSendAssistantMessageId: shown.answerId, provider: send.provider,
      providerRequestPreview: {}, userId, userMessageId: shown.questionId });
    expect((await prisma.message.findUniqueOrThrow({ select: { parentMessageId: true }, where: { id: regenerated.assistantMessageId } }))
      .parentMessageId).toBe(shown.questionId);
    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail!.messages.map((message) => message.id)).toEqual([shown.questionId, regenerated.assistantMessageId]);
  });

  it("starts the chat's shown history when nothing but quiet checks came before it", async () => {
    const userId = await owner();
    // A rotated chat whose checks all compared with a carried result and found nothing new.
    const { chatId, leaf } = await taskChat(userId, ["no_update", "no_update"]);
    expect(await repository.loadVisibleLeafMessageId?.(chatId, leaf)).toBeNull();
    expect(await repository.loadConversationContextForExpectedLeaf(chatId, userId, leaf)).toEqual([]);
    const created = await repository.createRun(sendInput(chatId, userId, leaf));
    expect((await prisma.message.findUniqueOrThrow({ select: { parentMessageId: true }, where: { id: created.userMessageId } }))
      .parentMessageId).toBeNull();
    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail!.messages.map((message) => message.id)).toEqual([created.userMessageId, created.assistantMessageId]);
    expect(detail!.messages[0]!.parentMessageId).toBeNull();
  });

  it("shows a check that follows a quiet one after the latest shown result while it runs", async () => {
    const userId = await owner();
    const { chatId, checks, leaf } = await taskChat(userId, ["baseline", "no_update"]);
    const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Check the release page"),
      parentMessageId: leaf, role: "user", scheduledTaskPrompt: true, status: "complete" } });
    const answer = await prisma.message.create({ data: { chatId, content: textMessageContent(""), parentMessageId: question.id,
      role: "assistant", status: "streaming" } });
    await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID(),
      status: "streaming", userId, userMessageId: question.id } });
    await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chatId } });
    const update = await repository.getChatUpdateForRun({ assistantMessageId: answer.id, chatId, userId, userMessageId: question.id });
    expect(update?.messages.find((message) => message.id === question.id)?.parentMessageId).toBe(checks[0]!.answerId);
  });
});
