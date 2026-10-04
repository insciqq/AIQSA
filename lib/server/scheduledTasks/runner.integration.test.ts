// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { scheduledTaskRunChatTitle } from "../../domain/scheduledTaskSchedule";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createSendMessageHandler } from "../runs/handlers";
import { createPrismaScheduledTaskOwnerLoader, createScheduledTaskSend, scheduledTaskOwnerAuth, scheduledTaskSendBody } from "./admission";
import { createPrismaScheduledTaskRunCatalogLoader } from "./catalog";
import { createScheduledTaskRunner } from "./runner";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { scheduledTaskScheduleColumns } from "./store";

const users: string[] = [];
const chats = createPrismaChatRepository();
const sendDeps = () => ({ ...createDefaultSendMessageDeps(), allowFakeProvider: true });

function runner() {
  return createScheduledTaskRunner({
    appBaseUrl: "http://localhost:3000",
    loadCatalog: createPrismaScheduledTaskRunCatalogLoader(prisma),
    async renameChat(input) { await chats.updateChat(input); },
    // The ordinary send admission, with the fake provider of the disposable stand.
    send: createScheduledTaskSend({ loadOwner: createPrismaScheduledTaskOwnerLoader(prisma), sendDeps: sendDeps() }),
    store: createPrismaScheduledTaskRunnerStore(prisma)
  });
}

async function due(taskId: string): Promise<void> {
  await prisma.scheduledTask.update({ data: { nextRunAt: new Date(Date.now() - 1_000), status: "ACTIVE" }, where: { id: taskId } });
}

async function ownerWithTask(chatMode: "NEW" | "SAME") {
  const userId = `scheduled-e2e-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({ data: { displayName: "Synthetic scheduled owner", id: userId, status: "active" } });
  await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled", userId } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
  const task = await prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatMode, modelId: providerTemplateIds.fakeModel,
    nextRunAt: new Date(Date.now() - 1_000), prompt: "Summarize the synthetic fixture", provider: providerTemplateIds.fakeConnection,
    timeZone: "Europe/Moscow", title: "Synthetic brief", userId
  } });
  return { task, userId };
}

/** The owner's own message in a chat, through the same send handler with their session. */
async function ownerMessage(userId: string, taskId: string, chatId: string, text: string): Promise<void> {
  const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
  const response = await createSendMessageHandler({ ...sendDeps(),
    resolveAuth: scheduledTaskOwnerAuth(createPrismaScheduledTaskOwnerLoader(prisma), { taskId, userId }) })(
    new Request(`http://localhost/api/chats/${chatId}/messages`, { body: JSON.stringify(scheduledTaskSendBody({
      admissionId: randomUUID(), modelId: providerTemplateIds.fakeModel, prompt: text, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, target: { activeLeafMessageId: chat.activeLeafMessageId, chatId, kind: "existing" },
      timeZone: "Europe/Moscow", toolCalling: true
    })), method: "POST" }), { params: { chatId } });
  expect(response.status).toBe(200);
  await response.text();
}

/** A stored message's text. */
function text(content: unknown): string {
  return textFromContentBlocks(content !== null && typeof content === "object" ? content as { blocks?: unknown[] } : {});
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("scheduled task end to end", () => {
  it("continues one Memory-excluded chat and gives each run only the previous result and its prompt", async () => {
    const { task, userId } = await ownerWithTask("SAME");
    const scheduler = runner();

    await scheduler.tick();
    await scheduler.idle();
    const first = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(first.chatId).not.toBeNull();
    expect(first.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(first).toMatchObject({ consecutiveFailures: 0, generation: 1, revision: 1, status: "ACTIVE" });
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: first.chatId! } }))
      .toMatchObject({ memoryMode: "EXCLUDED", projectId: null, title: "Synthetic brief", userId });
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    expect(occurrence).toMatchObject({ chatId: first.chatId, reasonCode: null, state: "COMPLETED", taskGeneration: 1, trigger: "schedule" });
    expect(occurrence!.unseenAt).not.toBeNull();
    const firstRun = await prisma.modelRun.findUniqueOrThrow({ where: { id: occurrence!.runId! } });
    expect(firstRun).toMatchObject({ chatId: first.chatId, modelId: "fake-qsa", scheduledOccurrenceId: occurrence!.id,
      scheduledTaskGeneration: 1, scheduledTaskId: task.id, status: "complete", userMessageId: occurrence!.userMessageId });
    expect(first).toMatchObject({ baselineAssistantMessageId: firstRun.assistantMessageId, baselineGeneration: 1,
      baselineRunId: firstRun.id, baselineUserMessageId: firstRun.userMessageId });

    // The owner keeps chatting in the task's chat between runs.
    await ownerMessage(userId, task.id, first.chatId!, "Synthetic owner question");

    await due(task.id);
    await scheduler.tick();
    await scheduler.idle();
    const second = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(second.chatId).toBe(first.chatId);
    const occurrences = await prisma.scheduledTaskOccurrence.findMany({ orderBy: { scheduledFor: "asc" }, where: { taskId: task.id } });
    expect(occurrences.map((row) => row.state)).toEqual(["COMPLETED", "COMPLETED"]);
    const messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" }, where: { chatId: first.chatId! } });
    expect(messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"], ["assistant", "complete"], ["user", "complete"], ["assistant", "complete"],
      ["user", "complete"], ["assistant", "complete"]
    ]);
    // The transcript stays linear: the run continues after the owner's turn...
    expect(messages[4]!.parentMessageId).toBe(messages[3]!.id);
    // ...but its model saw only the previous result and the prompt (the fake provider lists earlier user turns).
    expect(text(messages[5]!.content))
      .toBe("Fake answer: Summarize the synthetic fixture\nContext memory: Summarize the synthetic fixture");
    // The owner's own message saw the whole chat and is not a scheduled run.
    expect(text(messages[3]!.content)).toContain("Synthetic owner question");
    const ownerRun = await prisma.modelRun.findFirstOrThrow({ where: { userMessageId: messages[2]!.id } });
    expect(ownerRun).toMatchObject({ scheduledOccurrenceId: null, scheduledTaskGeneration: null, scheduledTaskId: null });
    expect(second).toMatchObject({ baselineRunId: occurrences[1]!.runId, baselineUserMessageId: messages[4]!.id });
  });

  it("starts a new dated chat for every run in new-chat mode, each seeing only its prompt", async () => {
    const { task, userId } = await ownerWithTask("NEW");
    const scheduler = runner();
    await scheduler.tick();
    await scheduler.idle();
    await due(task.id);
    await scheduler.tick();
    await scheduler.idle();
    const occurrences = await prisma.scheduledTaskOccurrence.findMany({ orderBy: { scheduledFor: "asc" }, where: { taskId: task.id } });
    expect(occurrences.map((row) => row.state)).toEqual(["COMPLETED", "COMPLETED"]);
    const chatIds = occurrences.map((row) => row.chatId!);
    expect(new Set(chatIds).size).toBe(2);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ chatId: chatIds[1] });
    for (const [index, chatId] of chatIds.entries()) {
      expect(await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
        memoryMode: "EXCLUDED", title: scheduledTaskRunChatTitle("Synthetic brief", occurrences[index]!.scheduledFor, "Europe/Moscow"), userId
      });
      const answers = await prisma.message.findMany({ where: { chatId, role: "assistant" } });
      expect(answers.map((message) => text(message.content)))
        .toEqual(["Fake answer: Summarize the synthetic fixture"]);
    }
  });
});
