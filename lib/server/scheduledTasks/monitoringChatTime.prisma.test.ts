// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createNativeRunStore } from "../engine/runStore";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import type { CreateRunInput, RunUsageAttribution, ScheduledOccurrenceAdmission, ScheduledResultCopy } from "../runs/runRepositoryContract";
import type { MonitoringVerdict } from "./runnerPolicy";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { scheduledTaskScheduleColumns } from "./store";

const users: string[] = [];
const runner = createPrismaScheduledTaskRunnerStore(prisma);
const runs = createPrismaRunRepository(prisma);
const store = createNativeRunStore(prisma);
let instants = 0;

async function owner(): Promise<string> {
  const id = `monitoring-chat-time-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic monitoring chat time", email: `${id}@example.test`, id, status: "active" } });
  await prisma.userSettings.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled", userId: id } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId: id } });
  users.push(id);
  return id;
}

async function monitoringTask(userId: string) {
  return prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatMode: "SAME", emailNotify: false, kind: "MONITORING",
    modelId: providerTemplateIds.fakeModel, nextRunAt: null, prompt: "Synthetic monitoring prompt",
    provider: providerTemplateIds.fakeConnection, searchEnabled: false, status: "PAUSED", timeZone: "Europe/Moscow",
    title: "Synthetic monitor", userId
  } });
}

/**
 * A send into `chatId` as the send handler hands it to run creation: with `check`, a monitoring check's occurrence
 * (its request marked as the check run preparation freezes); with `create`, the send that creates that chat.
 */
async function runInput(userId: string, chatId: string, check: Readonly<{
  create?: boolean; occurrence: Partial<ScheduledOccurrenceAdmission> & Pick<ScheduledOccurrenceAdmission, "occurrenceId">;
  previousResultShown: boolean;
}> | null): Promise<CreateRunInput> {
  const content = textMessageContent(check ? "Synthetic monitoring prompt" : "The owner's own question");
  const leaf = check?.create ? null
    : (await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chatId } })).activeLeafMessageId;
  const current = check ? await prisma.scheduledTask.findFirstOrThrow({ where: { userId } }) : null;
  return {
    chatId, content, expectedActiveLeafId: leaf, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
    providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId }),
    normalizedRequest: { attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "none",
      ...(check ? { monitoringPreviousResult: check.previousResultShown, monitoringVerdictTool: true as const } : {}) },
    ...(check?.create ? { personalChat: { defaultProviderModelId: providerTemplateIds.fakeModel, folderId: null, memoryMode: "EXCLUDED" as const } }
      : {}),
    ...(check && current ? { scheduledOccurrence: { monitoring: true as const, previousResult: null, relevantMcpServerIds: null,
      taskChatEpoch: current.chatEpoch, taskGeneration: current.generation, taskId: current.id, taskRevision: current.revision,
      ...check.occurrence } } : {}),
    userId
  };
}

/** Admits a check of the user's monitoring task into `chatId`. */
async function admitCheck(userId: string, chatId: string, previousResultShown: boolean,
  overrides: Partial<ScheduledOccurrenceAdmission> = {}, create = false) {
  const task = await prisma.scheduledTask.findFirstOrThrow({ where: { userId } });
  const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
    scheduledFor: new Date(Date.now() + (instants += 1)), startedAt: new Date(), taskId: task.id, trigger: "schedule", userId
  } });
  const run = await runs.createRun(await runInput(userId, chatId,
    { create, occurrence: { occurrenceId: occurrence.id, ...overrides }, previousResultShown }));
  return { occurrenceId: occurrence.id, scope: { assistantMessageId: run.assistantMessageId, chatId, runId: run.runId, userId } };
}

type Check = Awaited<ReturnType<typeof admitCheck>>;

/** The check's answer, its verdict and its terminal write, as the engine leaves them. */
async function answer(check: Check, verdict: MonitoringVerdict) {
  expect(await runs.recordMonitoringVerdict!({ runId: check.scope.runId, userId: check.scope.userId, verdict })).toBe(true);
  expect(await store.publishAnswer(check.scope, { followupRevision: 0, text: `Synthetic check: ${verdict}` })).toBe(true);
  expect(await store.complete(check.scope)).toBe(true);
}

const usage: RunUsageAttribution = { estimatedCostMicros: 5, modelId: "fake-qsa", operationCount: 1, provider: "fake",
  purpose: "chat_answer", usage: { inputTokens: 10, outputTokens: 2 } };

const chatTime = async (chatId: string) =>
  (await prisma.chat.findUniqueOrThrow({ select: { updatedAt: true }, where: { id: chatId } })).updatedAt;

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("a monitoring chat's place in the chat list", () => {
  it("stays through a hidden check's admission, terminal write, settlement and late usage; a shown check and the owner move it", async () => {
    const userId = await owner();
    await monitoringTask(userId);
    const kept = new Date("2025-03-01T08:00:00.000Z");
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Synthetic monitor", updatedAt: kept, userId } });
    const base = Date.now();

    // The first check is the starting point: shown, so its settlement, and only its settlement, moves the chat.
    const first = await admitCheck(userId, chat.id, false);
    expect(await chatTime(chat.id)).toEqual(kept);
    await answer(first, "update");
    expect(await chatTime(chat.id)).toEqual(kept);
    const shownAt = new Date(base - 30_000);
    expect(await runner.settleLinked(first.occurrenceId, shownAt)).toMatchObject({ reasonCode: "baseline", state: "COMPLETED" });
    expect(await chatTime(chat.id)).toEqual(shownAt);
    // Usage recorded after settlement counts and moves nothing.
    await store.applyUsageTotals(first.scope, [usage]);
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ totalInputTokens: 10, updatedAt: shownAt });

    // A check without news is hidden: none of its writes moves the chat.
    const quiet = await admitCheck(userId, chat.id, true);
    expect(await chatTime(chat.id)).toEqual(shownAt);
    await answer(quiet, "no_update");
    expect(await chatTime(chat.id)).toEqual(shownAt);
    expect(await runner.settleLinked(quiet.occurrenceId, new Date(base - 20_000))).toMatchObject({ reasonCode: "no_update" });
    expect(await chatTime(chat.id)).toEqual(shownAt);
    await store.applyUsageTotals(quiet.scope, [usage]);
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ totalInputTokens: 20, updatedAt: shownAt });
    // Its turn is in the chat all the same.
    expect((await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).activeLeafMessageId).toBe(quiet.scope.assistantMessageId);

    // News moves the chat to its settlement time.
    const news = await admitCheck(userId, chat.id, true);
    await answer(news, "update");
    expect(await chatTime(chat.id)).toEqual(shownAt);
    const newsAt = new Date(base - 10_000);
    expect(await runner.settleLinked(news.occurrenceId, newsAt)).toMatchObject({ reasonCode: "update" });
    expect(await chatTime(chat.id)).toEqual(newsAt);

    // The owner's own message moves it as every message does.
    await runs.createRun(await runInput(userId, chat.id, null));
    expect((await chatTime(chat.id)).getTime()).toBeGreaterThan(newsAt.getTime());
  });

  it("gives the month's new chat the place of the chat the task moves off until a result is shown", async () => {
    const userId = await owner();
    const task = await monitoringTask(userId);
    const octoberChat = randomUUID();
    const october = await admitCheck(userId, octoberChat, false,
      { chatPeriod: "2026-10", newChat: { title: "Synthetic monitor · October 2026" } }, true);
    await answer(october, "update");
    const octoberAt = new Date();
    expect(await runner.settleLinked(october.occurrenceId, octoberAt)).toMatchObject({ reasonCode: "baseline" });
    expect(await chatTime(octoberChat)).toEqual(octoberAt);

    const copy: ScheduledResultCopy = { answer: "Synthetic check: update", reliedServerIds: [],
      sourceAssistantMessageId: october.scope.assistantMessageId, sourceChatId: octoberChat };
    const novemberChat = randomUUID();
    const november = await admitCheck(userId, novemberChat, true, { chatPeriod: "2026-11",
      newChat: { title: "Synthetic monitor · November 2026" }, previousResultCopy: copy,
      rotation: { fromChatId: octoberChat, seedId: null } }, true);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ chatId: novemberChat });
    expect(await chatTime(novemberChat)).toEqual(octoberAt);
    await answer(november, "no_update");
    expect(await runner.settleLinked(november.occurrenceId, new Date())).toMatchObject({ reasonCode: "no_update" });
    expect(await chatTime(novemberChat)).toEqual(octoberAt);
    // The chat moved off is only read.
    expect(await chatTime(octoberChat)).toEqual(octoberAt);
  });
});
