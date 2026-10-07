// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { scheduledTaskRunChatTitle } from "../../domain/scheduledTaskSchedule";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createDefaultSendMessageDeps } from "../runs/defaultSendMessageDeps";
import { createSendMessageHandler, stopModelRun } from "../runs/handlers";
import type { CreateRunInput } from "../runs/runRepositoryContract";
import { createPrismaScheduledTaskOwnerLoader, createScheduledTaskSend, scheduledTaskOwnerAuth, scheduledTaskSendBody } from "./admission";
import { createPrismaScheduledTaskRunCatalogLoader } from "./catalog";
import { planScheduledTaskUpdate } from "./mutations";
import { createScheduledTaskRunner } from "./runner";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { createPrismaScheduledTaskStore, scheduledTaskScheduleColumns } from "./store";

const users: string[] = [];
const chats = createPrismaChatRepository();
const sendDeps = () => ({ ...createDefaultSendMessageDeps(), allowFakeProvider: true });

function runner(deps: ReturnType<typeof sendDeps> = sendDeps(), now?: () => Date) {
  return createScheduledTaskRunner({
    appBaseUrl: "http://localhost:3000",
    loadCatalog: createPrismaScheduledTaskRunCatalogLoader(prisma),
    ...(now ? { now } : {}),
    async renameChat(input) { await chats.updateChat(input); },
    // The ordinary send admission, with the fake provider of the disposable stand.
    send: createScheduledTaskSend({ loadOwner: createPrismaScheduledTaskOwnerLoader(prisma), sendDeps: deps }),
    stopRun: ({ code, message, runId, userId }) => stopModelRun(deps, { payload: { code, message }, runId, userId }),
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
      timeZone: "Europe/Moscow", toolCalling: true, toolsEnabled: false, workspaceEnabled: false
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
    const answer = text(messages[5]!.content);
    expect(answer).toContain("Context memory: Summarize the synthetic fixture");
    expect(answer).not.toContain("Synthetic owner question");
    // The owner's own message saw the whole chat and is not a scheduled run.
    expect(text(messages[3]!.content)).toContain("Context memory: Summarize the synthetic fixture");
    const ownerRun = await prisma.modelRun.findFirstOrThrow({ where: { userMessageId: messages[2]!.id } });
    expect(ownerRun).toMatchObject({ scheduledOccurrenceId: null, scheduledTaskGeneration: null, scheduledTaskId: null });
    expect(second).toMatchObject({ baselineRunId: occurrences[1]!.runId, baselineUserMessageId: messages[4]!.id });
    // Message limits count the owner's own message only, never the task's runs.
    expect(await prisma.usageMessageAdmission.findMany({ select: { createdAt: true }, where: { userId } }))
      .toEqual([{ createdAt: ownerRun.createdAt }]);
  });

  it("retries an occurrence while its owner's budget is used up, then skips it and keeps the task active", async () => {
    const { task, userId } = await ownerWithTask("SAME");
    // A zero budget is used up before any spend.
    await prisma.usageLimit.create({ data: { monthlyBudgetMicros: 0, userId } });
    let now = new Date();
    const scheduler = runner(sendDeps(), () => now);

    await scheduler.tick();
    await scheduler.idle();
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    expect(occurrence).toMatchObject({ reasonCode: "usage_budget_exhausted", runId: null, state: "PENDING" });

    // Still used up when the retry window ends: skipped with its reason, never a failure.
    now = new Date(now.getTime() + 31 * 60_000);
    await scheduler.tick();
    await scheduler.idle();
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence!.id } }))
      .toMatchObject({ reasonCode: "usage_budget_exhausted", runId: null, state: "SKIPPED" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } }))
      .toMatchObject({ consecutiveFailures: 0, status: "ACTIVE" });
    // No run, no turn, no usage and no message admission.
    expect(await prisma.modelRun.count({ where: { userId } })).toBe(0);
    expect(await prisma.message.count({ where: { chat: { userId } } })).toBe(0);
    expect(await prisma.usageEvent.count({ where: { userId } })).toBe(0);
    expect(await prisma.usageMessageAdmission.count({ where: { userId } })).toBe(0);
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
      // A first send in its own chat: no earlier turn reached the model.
      const answers = await prisma.message.findMany({ where: { chatId, role: "assistant" } });
      expect(answers).toHaveLength(1);
      expect(text(answers[0]!.content)).toContain("Fake answer: Summarize the synthetic fixture");
      expect(text(answers[0]!.content)).not.toContain("Context memory");
    }
  });

  it("never starts a run its owner paused while the admission was in flight", async () => {
    const { task, userId } = await ownerWithTask("SAME");
    const owners = createPrismaScheduledTaskStore(prisma);
    const deps = sendDeps();
    let pauses = 0;
    // The runner read the task and the send was prepared: the owner's pause,
    // through the owner API's own update, commits just before run creation.
    const scheduler = runner({ ...deps, repository: { ...deps.repository, async createRun(input: CreateRunInput) {
      if (pauses === 0) {
        pauses += 1;
        const current = await owners.get(userId, task.id);
        if (!current) throw new Error("scheduled_e2e_task_missing");
        const plan = planScheduledTaskUpdate(current, { expectedRevision: current.revision, status: "paused" }, new Date());
        if (!plan.ok) throw new Error(plan.code);
        await owners.update(userId, task.id, {
          draft: plan.draft, expectedRevision: current.revision, nextRunAt: plan.nextRunAt, promptUrls: "keep", status: plan.status
        });
      }
      return deps.repository.createRun(input);
    } } });

    await scheduler.tick();
    await scheduler.idle();
    expect(pauses).toBe(1);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } }))
      .toMatchObject({ nextRunAt: null, revision: 2, status: "PAUSED" });
    // The admission fenced on the revision read before preparation and rolled
    // back whole: no run or turn, and the occurrence still has no run.
    expect(await prisma.modelRun.count({ where: { userId } })).toBe(0);
    expect(await prisma.message.count({ where: { chat: { userId } } })).toBe(0);
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    expect(occurrence).toMatchObject({ runId: null, state: "PENDING", trigger: "schedule" });

    // The next tick reads the pause and skips the instant: the run never starts.
    await scheduler.tick();
    await scheduler.idle();
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence!.id } }))
      .toMatchObject({ reasonCode: "paused", runId: null, state: "SKIPPED" });
    expect(await prisma.modelRun.count({ where: { userId } })).toBe(0);
    expect(pauses).toBe(1);
  });
});
