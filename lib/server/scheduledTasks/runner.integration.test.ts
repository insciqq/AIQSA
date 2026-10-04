// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createPrismaScheduledTaskOwnerLoader, createScheduledTaskSend } from "./admission";
import { createPrismaScheduledTaskRunCatalogLoader } from "./catalog";
import { createScheduledTaskRunner } from "./runner";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { scheduledTaskScheduleColumns } from "./store";

const users: string[] = [];
const chats = createPrismaChatRepository();

function runner() {
  return createScheduledTaskRunner({
    appBaseUrl: "http://localhost:3000",
    loadCatalog: createPrismaScheduledTaskRunCatalogLoader(prisma),
    async renameChat(input) { await chats.updateChat(input); },
    // The ordinary send admission, with the fake provider of the disposable stand.
    send: createScheduledTaskSend({
      loadOwner: createPrismaScheduledTaskOwnerLoader(prisma),
      sendDeps: { ...createDefaultSendMessageDeps(), allowFakeProvider: true }
    }),
    store: createPrismaScheduledTaskRunnerStore(prisma)
  });
}

async function due(taskId: string): Promise<void> {
  await prisma.scheduledTask.update({ data: { nextRunAt: new Date(Date.now() - 1_000), status: "ACTIVE" }, where: { id: taskId } });
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("scheduled task end to end", () => {
  it("posts each due instant into the task's own Memory-excluded chat through the ordinary send admission", async () => {
    const userId = `scheduled-e2e-${randomUUID()}`;
    users.push(userId);
    await prisma.user.create({ data: { displayName: "Synthetic scheduled owner", id: userId, status: "active" } });
    await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled", userId } });
    await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId } });
    const task = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), modelId: providerTemplateIds.fakeModel,
      nextRunAt: new Date(Date.now() - 1_000), prompt: "Summarize the synthetic fixture", provider: providerTemplateIds.fakeConnection,
      timeZone: "Europe/Moscow", title: "Synthetic brief", userId
    } });
    const scheduler = runner();

    await scheduler.tick();
    await scheduler.idle();
    const first = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(first.chatId).not.toBeNull();
    expect(first.unseenResultAt).not.toBeNull();
    expect(first.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(first).toMatchObject({ consecutiveFailures: 0, revision: 1, status: "ACTIVE" });
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: first.chatId! } }))
      .toMatchObject({ memoryMode: "EXCLUDED", projectId: null, title: "Synthetic brief", userId });
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    expect(occurrence).toMatchObject({ chatId: first.chatId, reasonCode: null, state: "COMPLETED", trigger: "schedule" });
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: occurrence!.runId! } }))
      .toMatchObject({ chatId: first.chatId, modelId: "fake-qsa", status: "complete", userMessageId: occurrence!.userMessageId });

    await due(task.id);
    await scheduler.tick();
    await scheduler.idle();
    const second = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(second.chatId).toBe(first.chatId);
    const occurrences = await prisma.scheduledTaskOccurrence.findMany({ orderBy: { scheduledFor: "asc" }, where: { taskId: task.id } });
    expect(occurrences.map((row) => row.state)).toEqual(["COMPLETED", "COMPLETED"]);
    const messages = await prisma.message.findMany({ orderBy: { createdAt: "asc" }, where: { chatId: first.chatId! } });
    expect(messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"], ["assistant", "complete"], ["user", "complete"], ["assistant", "complete"]
    ]);
    // The second turn continues the first answer, like an ordinary follow-up in the chat.
    expect(messages[2]!.parentMessageId).toBe(messages[1]!.id);
    expect(JSON.stringify(messages[3]!.content)).toContain("Fake answer: Summarize the synthetic fixture");
  });
});
