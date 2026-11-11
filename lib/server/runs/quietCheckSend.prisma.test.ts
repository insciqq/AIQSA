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

type Check = Readonly<{ answerId: string; questionId: string; runId: string }>;

/** A task chat of checks with these outcomes, each a scheduled turn, its answer and the native run that settled it. */
async function taskChat(userId: string, outcomes: readonly (string | null)[]) {
  const { id: chatId } = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Watch", userId } });
  const checks: Check[] = [];
  let parentMessageId: string | null = null;
  for (const [index, outcome] of outcomes.entries()) {
    const at = new Date(Date.UTC(2026, 10, 2, index));
    const question: { id: string } = await prisma.message.create({ data: { chatId, content: textMessageContent("Check the release page"),
      createdAt: at, parentMessageId, role: "user", scheduledTaskPrompt: true, status: "complete" } });
    const answer: { id: string } = await prisma.message.create({ data: { chatId,
      content: textMessageContent(outcome === "no_update" ? "" : "Version 1.0"), createdAt: at, parentMessageId: question.id,
      role: "assistant", status: "complete" } });
    const run: { id: string } = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, createdAt: at,
      engine: "native", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", scheduledOccurrenceId: randomUUID(),
      scheduledOutcome: outcome, scheduledTaskGeneration: 1, scheduledTaskId: randomUUID(), status: "complete", userId,
      userMessageId: question.id } });
    checks.push({ answerId: answer.id, questionId: question.id, runId: run.id });
    parentMessageId = answer.id;
  }
  await prisma.chat.update({ data: { activeLeafMessageId: parentMessageId }, where: { id: chatId } });
  return { chatId, checks, leaf: parentMessageId! };
}

describe("a message after quiet checks", () => {
  it.each([true, false])("continues the latest shown result through admission and finalization, Memory on: %s", async (memory) => {
    const userId = await owner();
    await prisma.userMemorySettings.upsert({ create: { referenceChatHistory: memory, useMemoryFacts: memory, userId },
      update: { referenceChatHistory: memory, useMemoryFacts: memory }, where: { userId } });
    const { chatId, checks, leaf } = await taskChat(userId, ["baseline", "no_update", "no_update"]);
    const shown = checks[0]!;
    // The browser names the result it was shown; the stored leaf reads as it.
    expect(await repository.loadVisibleLeafMessageId?.(chatId, leaf)).toBe(shown.answerId);
    expect(await repository.loadVisibleLeafMessageId?.(chatId, shown.answerId)).toBe(shown.answerId);
    expect((await repository.loadConversationContextForExpectedLeaf(chatId, userId, leaf))?.map((message) => message.id))
      .toEqual([shown.questionId, shown.answerId]);

    // Admission and finalization both read the message as written: under the shown result, never the quiet check.
    const created = await repository.createRun(sendInput(chatId, userId, leaf));
    const question = await prisma.message.findUniqueOrThrow({ select: { parentMessageId: true }, where: { id: created.userMessageId } });
    expect(question.parentMessageId).toBe(shown.answerId);
    expect((await prisma.modelRun.findUniqueOrThrow({ select: { status: true }, where: { id: created.runId } })).status).not.toBe("error");
    const attempts = await prisma.memoryRetrievalAttempt.findMany({ select: { preSendActiveLeafMessageId: true },
      where: { modelRunId: created.runId } });
    expect(attempts.every((attempt) => attempt.preSendActiveLeafMessageId === shown.answerId)).toBe(true);
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

  it("reads a branch without any quiet check, however old, for a reply, a regenerate and an edit", async () => {
    const userId = await owner();
    const { chatId, checks, leaf } = await taskChat(userId, ["baseline", "no_update", "no_update", "no_update", "update", "no_update",
      "no_update"]);
    const [baseline, , , third, update] = checks;
    const ids = async (messages: Promise<readonly Readonly<{ id: string }>[] | null>) => (await messages)?.map((message) => message.id);
    expect(await ids(repository.loadConversationContextForExpectedLeaf(chatId, userId, leaf)))
      .toEqual([baseline!.questionId, baseline!.answerId, update!.questionId, update!.answerId]);
    // A new answer to the update's question.
    expect(await ids(repository.loadConversationContextForLeaf(chatId, userId, update!.questionId)))
      .toEqual([baseline!.questionId, baseline!.answerId, update!.questionId]);
    // An edit of that question hangs where it does in storage, after the quiet checks.
    const edited: { id: string } = await prisma.message.create({ data: { chatId, content: textMessageContent("Check the changelog"),
      parentMessageId: third!.answerId, role: "user", status: "complete" } });
    expect(await ids(repository.loadConversationContextForLeaf(chatId, userId, edited.id)))
      .toEqual([baseline!.questionId, baseline!.answerId, edited.id]);
    // The chat's context figures measure the same branch.
    const detail = await createPrismaChatRepository(prisma).getChat({ chatId, userId });
    expect(detail!.contextStats.approximateActiveBranchInputTokens).toBeGreaterThan(0);
    expect(detail!.messages.map((message) => message.id))
      .toEqual([baseline!.questionId, baseline!.answerId, update!.questionId, update!.answerId]);
  });

  it("names a quiet check's run with an unknown call for the guard, with the next message the branch shows", async () => {
    const userId = await owner();
    const { chatId, checks, leaf } = await taskChat(userId, ["baseline", "no_update", "no_update", "update", "no_update"]);
    const [, first, second, update, tail] = checks;
    const reply: { id: string } = await prisma.message.create({ data: { chatId, content: textMessageContent("What changed?"),
      parentMessageId: leaf, role: "user", status: "complete" } });
    const call = (modelRunId: string, data: Readonly<{ completedAt?: Date; result?: Record<string, string>;
      state: "complete" | "error" | "running" }>) => prisma.modelRunToolCall.create({ data: {
      arguments: { summary: "x" }, modelRunId, ordinal: 0, providerCallId: `call-${modelRunId}`, roundIndex: 0,
      startedAt: new Date(), toolName: "mcp_jira_create_issue", ...data } });
    expect(await repository.loadQuietCheckEffectRuns?.({ chatId, userId, userMessageId: reply.id })).toEqual([]);
    await call(first!.runId, { state: "running" });
    await call(second!.runId, { completedAt: new Date(), result: { output: "Created A-1" }, state: "complete" });
    await call(tail!.runId, { completedAt: new Date(), result: { code: "run_ended", outcome: "unknown" }, state: "error" });
    // A shown check's own unknown call is the conversation's, never this lookup's.
    await call(update!.runId, { state: "running" });
    expect(new Set(await repository.loadQuietCheckEffectRuns?.({ chatId, userId, userMessageId: reply.id }))).toEqual(new Set([
      { nextMessageId: update!.questionId, runId: first!.runId },
      { nextMessageId: reply.id, runId: tail!.runId }
    ]));
  });

  it("shows a check that follows a quiet one after the latest shown result while it runs", async () => {
    const userId = await owner();
    const { chatId, checks, leaf } = await taskChat(userId, ["baseline", "no_update"]);
    const question: { id: string } = await prisma.message.create({ data: { chatId, content: textMessageContent("Check the release page"),
      parentMessageId: leaf, role: "user", scheduledTaskPrompt: true, status: "complete" } });
    const answer: { id: string } = await prisma.message.create({ data: { chatId, content: textMessageContent(""),
      parentMessageId: question.id, role: "assistant", status: "streaming" } });
    await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId, modelId: "fake-qsa", normalizedRequest: {},
      provider: "fake", scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID(),
      status: "streaming", userId, userMessageId: question.id } });
    await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chatId } });
    const update = await repository.getChatUpdateForRun({ assistantMessageId: answer.id, chatId, userId, userMessageId: question.id });
    expect(update?.messages.find((message) => message.id === question.id)?.parentMessageId).toBe(checks[0]!.answerId);
  });
});
