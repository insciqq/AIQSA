import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { textMessageContent } from "../../domain/content";
import { chatExportDocument } from "../../domain/chatExportDocument";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { loadAuthorizedChatExportSource } from "../chats/exportChat";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaShareRepository } from "../shares/prismaRepository";
import { createPrismaRunRepository } from "./prismaRepository";
import { createPrismaRunToolLoopOperations } from "./prismaRepositoryToolLoop";
import { createRetiredEngineRunFinder, endRetiredEngineRuns, endRetiredEngineRunsFor } from "./retiredEngineRuns";
import type { CreateRunInput } from "./runRepositoryContract";

// Answers the old run core wrote before the upgrade stay ordinary chat
// history: read, exported, shared, regenerated and edited like any other.

const owners: string[] = [];
const runs = createPrismaRunRepository(prisma);

async function owner(): Promise<string> {
  const userId = `retired-engine-answer-${randomUUID()}`;
  owners.push(userId);
  await prisma.user.create({ data: { displayName: "Retired engine answer test", id: userId, status: "active",
    settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled" } } } });
  return userId;
}

/** A chat whose one answer the old core completed, with its tool step, citation and checkpoint. */
async function oldCoreAnswer(userId: string) {
  const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Old core chat", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Old question"),
    role: "user", status: "complete" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Old core answer"),
    modelId: "fake-qsa", parentMessageId: question.id, provider: "fake", role: "assistant", status: "streaming" } });
  await prisma.chat.update({ data: { activeLeafMessageId: answer.id }, where: { id: chat.id } });
  const run = await prisma.modelRun.create({ data: { answerStartedAt: new Date(Date.now() - 4_000), assistantMessageId: answer.id,
    chatId: chat.id, engine: "v1", modelId: "fake-qsa", normalizedRequest: {}, provider: "fake", status: "streaming",
    toolLoopState: { roundIndex: 1, version: 1 }, userId, userMessageId: question.id } });
  // A tool only the old core had, as its step list stored it.
  await prisma.modelRunToolCall.create({ data: { arguments: { call_ref: "tcr1_synthetic" }, completedAt: new Date(),
    modelRunId: run.id, ordinal: 0, providerCallId: "old-call", result: { callId: "old-call", content: [{ text: "Saved result", type: "text" }],
      name: "read_tool_call", status: "complete" }, roundIndex: 0, startedAt: new Date(), state: "complete", toolName: "read_tool_call" } });
  await createPrismaRunToolLoopOperations(prisma).appendRunOutputEvent(run.id, { data: { artifactType: "citation",
    payload: { index: 1, title: "Source", url: "https://example.test/source" } }, type: "artifact" });
  await prisma.message.update({ data: { status: "complete" }, where: { id: answer.id } });
  await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.id } });
  return { answerId: answer.id, chatId: chat.id, questionId: question.id, runId: run.id };
}

function regenerationInput(chatId: string, userId: string, answerId: string, questionId: string) {
  const content = textMessageContent("Old question");
  const normalizedRequest: CreateRunInput["normalizedRequest"] = {
    attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto"
  };
  return { chatId, defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
    searchPlan: { mode: "all_selected" as const, optionIds: [] }, userId }, modelId: "fake-qsa", normalizedRequest,
  preSendAssistantMessageId: answerId, provider: "fake", providerRequestPreview: {}, userId, userMessageId: questionId };
}

afterEach(async () => {
  for (const id of owners.splice(0)) await prisma.user.deleteMany({ where: { id } });
});
afterAll(() => prisma.$disconnect());

describe("answers the old run core completed", () => {
  it("read, export and share like any answer, without the old core's tool payloads", async () => {
    const userId = await owner();
    const old = await oldCoreAnswer(userId);

    const chat = await createPrismaChatRepository(prisma).getChat({ chatId: old.chatId, userId });
    const answer = chat?.messages.find((message) => message.id === old.answerId);
    expect(answer).toMatchObject({ content: textMessageContent("Old core answer"), status: "complete",
      artifactSummary: { citations: [{ index: 1, title: "Source", url: "https://example.test/source" }] } });

    const source = await loadAuthorizedChatExportSource(prisma, { chatId: old.chatId, userId });
    const document = chatExportDocument(source!, new Date());
    expect(document.chat.messages.map((message) => [message.role, message.text]))
      .toEqual([["user", "Old question"], ["assistant", "Old core answer"]]);
    expect(JSON.stringify(document)).not.toMatch(/Saved result|tcr1_synthetic|read_tool_call/);

    const share = await createPrismaShareRepository(prisma).createChatShare({ activeLeafMessageId: old.answerId, chatId: old.chatId,
      shareToken: randomUUID(), slugHash: randomUUID(), userId });
    expect(share && "snapshot" in share ? share.snapshot.messages.at(-1)?.content : null).toEqual(textMessageContent("Old core answer"));
    expect(JSON.stringify(share)).not.toMatch(/Saved result|tcr1_synthetic|read_tool_call/);
  });

  it("enters the next turn's context as its text and regenerates on the agent engine", async () => {
    const userId = await owner();
    const old = await oldCoreAnswer(userId);
    const context = await runs.loadConversationContextForExpectedLeaf(old.chatId, userId, old.answerId);
    expect(context?.map((message) => [message.role, message.content])).toEqual([
      ["user", textMessageContent("Old question")], ["assistant", textMessageContent("Old core answer")]]);

    expect(await runs.findRegenerationSource(old.answerId, userId)).toMatchObject({ assistantMessage: { id: old.answerId } });
    const again = await runs.createRegenerationRun(regenerationInput(old.chatId, userId, old.answerId, old.questionId));
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: again.runId } })).resolves.toMatchObject({ engine: "native" });
    // The old answer stays as the earlier version beside the new one.
    await expect(prisma.message.findUniqueOrThrow({ where: { id: old.answerId } })).resolves.toMatchObject({ status: "complete" });
  });

  // Regression (codex review): a run the startup sweep could not end held its chat until a restart.
  it("left running ends when its chat opens or its user sends, and only that chat's or user's", async () => {
    const userId = await owner();
    const otherId = await owner();
    const active = async (ownerId: string) => {
      const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, title: "Old core", userId: ownerId } });
      const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Old question"),
        role: "user", status: "complete" } });
      const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id,
        role: "assistant", status: "streaming" } });
      const run = await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, engine: "v1", modelId: "fake-qsa",
        normalizedRequest: {}, provider: "fake", status: "streaming", userId: ownerId, userMessageId: question.id } });
      return { answerId: answer.id, chatId: chat.id, runId: run.id };
    };
    const opened = await active(userId);
    const sent = await active(userId);
    const stranger = await active(otherId);
    const deps = { findRuns: createRetiredEngineRunFinder(prisma), repository: runs };
    const status = async (run: { answerId: string; runId: string }) => [
      (await prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).status,
      (await prisma.message.findUniqueOrThrow({ where: { id: run.answerId } })).status];

    await endRetiredEngineRunsFor(deps, { chatId: opened.chatId, userId });
    await expect(status(opened)).resolves.toEqual(["error", "error"]);
    await expect(status(sent)).resolves.toEqual(["streaming", "streaming"]);
    await expect(prisma.modelRun.findUniqueOrThrow({ where: { id: opened.runId } })).resolves.toMatchObject({
      errorPayload: expect.objectContaining({ code: RUN_INTERRUPTED_FAILURE.code, recoveryTerminal: true }) });
    // Another owner's chat id under this user's scope ends nothing.
    await endRetiredEngineRunsFor(deps, { chatId: stranger.chatId, userId });
    await endRetiredEngineRunsFor(deps, { userId });
    await expect(status(sent)).resolves.toEqual(["error", "error"]);
    await expect(status(stranger)).resolves.toEqual(["streaming", "streaming"]);
    // Ending is idempotent: the sweep finds nothing left of this user's.
    await expect(endRetiredEngineRuns(deps, { userId })).resolves.toEqual({ found: 0, unended: [] });
  });

  it("branches when its question is edited, keeping the old answer on its own branch", async () => {
    const userId = await owner();
    const old = await oldCoreAnswer(userId);
    const edited = await createPrismaMessageBranchRepository(prisma).createEditedMessageBranch({
      content: textMessageContent("Edited question"), originalMessageId: old.questionId, userId });
    expect(edited).not.toBeNull();
    const chat = await createPrismaChatRepository(prisma).getChat({ chatId: old.chatId, userId });
    expect(chat?.messages.map((message) => message.id)).toEqual([edited!.id]);
    await expect(prisma.message.findUniqueOrThrow({ where: { id: old.answerId } })).resolves.toMatchObject({
      content: textMessageContent("Old core answer"), parentMessageId: old.questionId, status: "complete" });
  });
});
