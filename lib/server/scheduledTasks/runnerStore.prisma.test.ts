// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { SMTP_CONTROL_ID } from "../email/repository";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { ScheduledOccurrenceConflictError, type CreateRunInput, type ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";
import { SCHEDULED_TASK_OCCURRENCE_RETENTION } from "./runnerPolicy";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { createPrismaScheduledTaskStore, scheduledTaskScheduleColumns, ScheduledTaskError } from "./store";

const users: string[] = [];
const runner = createPrismaScheduledTaskRunnerStore(prisma);
const owners = createPrismaScheduledTaskStore(prisma);
const runs = createPrismaRunRepository(prisma);
const daily = { kind: "daily", time: "09:00" } as const;
const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } as const;

async function owner(): Promise<string> {
  const id = `scheduled-runner-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic scheduled runner", email: `${id}@example.test`, id, status: "active" } });
  await prisma.userSettings.create({ data: { defaultControlValues: { "fake:fake-qsa": { temperature: "0.2" } },
    defaultProviderModelId: providerTemplateIds.fakeModel, defaultSearchStrategyId: "search-disabled", userId: id } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId: id } });
  users.push(id);
  return id;
}

async function task(userId: string, nextRunAt: Date | null, overrides: Record<string, unknown> = {}) {
  return prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns(daily), chatMode: "SAME", emailNotify: false, modelId: providerTemplateIds.fakeModel, nextRunAt,
    prompt: "Synthetic scheduled prompt", provider: providerTemplateIds.fakeConnection, searchEnabled: false,
    status: nextRunAt ? "ACTIVE" : "PAUSED", timeZone: "Europe/Moscow", title: "Synthetic brief", userId, ...overrides
  } });
}

async function personalChat(userId: string, memoryMode: "EXCLUDED" | "NORMAL" = "EXCLUDED") {
  return prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode, title: "Synthetic brief", userId } });
}

/** The scheduled origin the runner passes for an occurrence of `created`, as read before preparation. */
function origin(occurrenceId: string, created: Readonly<{ generation: number; id: string; revision: number }>,
  overrides: Partial<ScheduledOccurrenceAdmission> = {}): ScheduledOccurrenceAdmission {
  return { occurrenceId, previousResult: null, taskGeneration: created.generation, taskId: created.id, taskRevision: created.revision,
    ...overrides };
}

/** A send into an existing chat, as the send handler hands it to run creation. */
async function runInput(userId: string, chatId: string, scheduledOccurrence?: ScheduledOccurrenceAdmission): Promise<CreateRunInput> {
  const content = textMessageContent("Synthetic scheduled prompt");
  const leaf = await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chatId } });
  return {
    chatId, content, expectedActiveLeafId: leaf.activeLeafMessageId, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
    defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId },
    providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId }),
    normalizedRequest: { attachmentIds: [], chatId, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "none" },
    ...(scheduledOccurrence ? { scheduledOccurrence } : {}),
    userId
  };
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted scheduled task runner", () => {
  it("claims each due task once under concurrent claimers and records one occurrence per instant", async () => {
    const userId = await owner();
    const due = new Date(Date.now() - 60_000);
    const created = await task(userId, due);
    const now = new Date();
    const claims = await Promise.all([runner.claimDue(now, 10), runner.claimDue(now, 10)]);
    expect(claims.reduce((sum, claim) => sum + claim.claimed, 0)).toBe(1);
    expect(await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: created.id } }))
      .toMatchObject([{ scheduledFor: due, state: "PENDING", trigger: "schedule" }]);
    const advanced = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
    expect(advanced.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(advanced.revision).toBe(1);
    await expect(prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: due, taskId: created.id, trigger: "schedule", userId } }))
      .rejects.toMatchObject({ code: "P2002" });
  });

  it("skips an hourly instant while the previous run is open and replaces a pending one that never got a run", async () => {
    const userId = await owner();
    const now = new Date();
    const instant = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const previous = new Date(instant.getTime() - 3_600_000);
    const busy = await task(userId, instant, { ...scheduledTaskScheduleColumns(hourly), emailNotify: true });
    const running = await prisma.scheduledTaskOccurrence.create({ data: {
      leaseExpiresAt: new Date(now.getTime() + 60_000), scheduledFor: previous, startedAt: previous, taskId: busy.id,
      trigger: "schedule", userId
    } });
    const otherOwner = await owner();
    const stale = await task(otherOwner, instant, scheduledTaskScheduleColumns(hourly));
    const waiting = await prisma.scheduledTaskOccurrence.create({ data: {
      reasonCode: "chat_busy", scheduledFor: previous, startedAt: new Date(now.getTime() - 10 * 60_000), taskId: stale.id,
      trigger: "schedule", userId: otherOwner
    } });
    const claim = await runner.claimDue(now, 10);
    expect(claim.claimed).toBe(2);
    // The admission in flight keeps its run; the new instant is skipped without notifying anyone.
    expect(await prisma.scheduledTaskOccurrence.findMany({ orderBy: { scheduledFor: "asc" }, where: { taskId: busy.id } }))
      .toMatchObject([{ id: running.id, state: "PENDING" },
        { finishedAt: now, reasonCode: "previous_running", scheduledFor: instant, state: "SKIPPED", unseenAt: null }]);
    // A busy retry ends when the next instant arrives, which takes its place.
    expect(await prisma.scheduledTaskOccurrence.findMany({ orderBy: { scheduledFor: "asc" }, where: { taskId: stale.id } }))
      .toMatchObject([{ id: waiting.id, reasonCode: "chat_busy", state: "SKIPPED", unseenAt: null },
        { reasonCode: null, scheduledFor: instant, state: "PENDING" }]);
    expect(claim.settlements.map((settlement) => [settlement.reasonCode, settlement.state, settlement.taskPaused]).sort())
      .toEqual([["chat_busy", "SKIPPED", false], ["previous_running", "SKIPPED", false]]);
  });

  it("links the occurrence inside run creation with the run's scheduled origin and rolls the run back when it cannot", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const chat = await personalChat(userId);
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      scheduledFor: new Date(), startedAt: new Date(), taskId: created.id, trigger: "manual", userId
    } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created)));
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).toMatchObject({
      chatId: chat.id, leaseExpiresAt: null, runId: run.runId, state: "RUNNING", taskGeneration: 1, userMessageId: run.userMessageId
    });
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({
      scheduledOccurrenceId: occurrence.id, scheduledTaskGeneration: 1, scheduledTaskId: created.id
    });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ chatId: chat.id, revision: 1 });
    // A scheduled send never rewrites the owner's saved composer controls.
    expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).defaultControlValues)
      .toEqual({ "fake:fake-qsa": { temperature: "0.2" } });

    // The occurrence already has its run: a second admission creates nothing.
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: run.runId, userId });
    const counts = async () => [await prisma.modelRun.count({ where: { chatId: chat.id } }), await prisma.message.count({ where: { chatId: chat.id } })];
    const before = await counts();
    await expect(runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    expect(await counts()).toEqual(before);

    // The owner paused or edited the task while the send was prepared: the admission rolls back.
    const fenced = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + 1), taskId: created.id,
      trigger: "manual", userId } });
    await prisma.scheduledTask.update({ data: { revision: { increment: 1 } }, where: { id: created.id } });
    await expect(runs.createRun(await runInput(userId, chat.id, origin(fenced.id, created))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    expect(await counts()).toEqual(before);
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: fenced.id } })).toMatchObject({ runId: null, state: "PENDING" });

    // A deleted task takes its occurrences along; admission for them rolls back too.
    const gone = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + 2), taskId: created.id,
      trigger: "manual", userId } });
    await prisma.scheduledTask.delete({ where: { id: created.id } });
    await expect(runs.createRun(await runInput(userId, chat.id, origin(gone.id, { ...created, revision: 2 }))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    expect(await counts()).toEqual(before);
  });

  it("admits a scheduled run without Personal Memory even in a chat the owner switched to Memory", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const chat = await personalChat(userId, "NORMAL");
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      scheduledFor: new Date(), startedAt: new Date(), taskId: created.id, trigger: "manual", userId
    } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created)));
    // Dispatchable at once: no Memory attempt, binding or command was created for it.
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({ status: "streaming" });
    expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: run.runId } })).toBe(0);
    expect(await prisma.modelRunMemoryBinding.count({ where: { modelRunId: run.runId } })).toBe(0);
  });

  it("settles linked occurrences from their runs, marks only news unread and keeps the newest result as the baseline", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { consecutiveFailures: 2 });
    const chat = await personalChat(userId);
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(), startedAt: new Date(),
      taskId: created.id, trigger: "schedule", userId } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created)));
    const now = new Date();
    expect(await runner.settleFinishedRuns(now, 10)).toEqual([]);
    await prisma.modelRun.update({ data: { errorPayload: { code: "run_orphaned", message: "x" }, status: "error" }, where: { id: run.runId } });
    expect(await runner.settleFinishedRuns(now, 10)).toEqual([{ occurrenceId: occurrence.id, reasonCode: "run_orphaned",
      runId: run.runId, state: "FAILED", taskPaused: true }]);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      baselineRunId: null, consecutiveFailures: 3, nextRunAt: null, pauseReason: "repeated_failures", revision: 2, status: "PAUSED"
    });
    // The failure that paused the task is news.
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).toMatchObject({ unseenAt: now });
    expect(await runner.settleLinked(occurrence.id, now)).toBeNull();

    // A completed run of the current generation becomes the baseline the next same-chat run sees.
    const paused = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
    const manual = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + 1), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const completed = await runs.createRun(await runInput(userId, chat.id, origin(manual.id, paused)));
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: completed.runId } });
    expect(await runner.settleLinked(manual.id, now)).toMatchObject({ state: "COMPLETED", taskPaused: false });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      baselineAssistantMessageId: completed.assistantMessageId, baselineGeneration: 1, baselineRunId: completed.runId,
      baselineUserMessageId: completed.userMessageId, consecutiveFailures: 0
    });
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: manual.id } })).toMatchObject({ unseenAt: now });

    // A result of an older generation (the prompt changed meanwhile) never becomes the baseline.
    const older = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + 2), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const olderRun = await runs.createRun(await runInput(userId, chat.id, origin(older.id, paused)));
    await prisma.scheduledTask.update({ data: { baselineAssistantMessageId: null, baselineGeneration: null, baselineRunId: null,
      baselineUserMessageId: null, generation: 2, revision: { increment: 1 } }, where: { id: created.id } });
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: olderRun.runId } });
    expect(await runner.settleLinked(older.id, now)).toMatchObject({ state: "COMPLETED" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ baselineRunId: null, generation: 2 });

    // A run that vanished (deleted with its chat) leaves a running occurrence without a run: it fails quietly, never runs again.
    const second = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + 3), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
    const secondRun = await runs.createRun(await runInput(userId, chat.id, origin(second.id, current)));
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: secondRun.runId, userId });
    await prisma.modelRun.delete({ where: { id: secondRun.runId } });
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ runId: null, state: "RUNNING" });
    expect(await runner.settleFinishedRuns(new Date(), 10)).toMatchObject([{ occurrenceId: second.id, reasonCode: "run_unavailable",
      state: "FAILED", taskPaused: false }]);
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ unseenAt: null });
  });

  it("counts a scheduled run against its owner's slot until it is terminal, even after its task is deleted", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const chat = await personalChat(userId);
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created)));
    const now = new Date();
    expect((await runner.loadDispatch(now, 10)).executing.get(userId)).toBe(1);
    await prisma.scheduledTask.delete({ where: { id: created.id } });
    expect((await runner.loadDispatch(now, 10)).executing.get(userId)).toBe(1);
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({ scheduledTaskId: created.id });
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: run.runId, userId });
    expect((await runner.loadDispatch(now, 10)).executing.get(userId)).toBeUndefined();
  });

  it("leases, retries and expires pending occurrences and prunes old history", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const now = new Date();
    const busy = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(now.getTime() - 40 * 60_000),
      taskId: created.id, trigger: "manual", userId } });
    expect(await runner.acquireLease(busy.id, now, new Date(now.getTime() + 60_000))).toBe(true);
    expect(await runner.acquireLease(busy.id, now, new Date(now.getTime() + 60_000))).toBe(false);
    expect((await runner.loadDispatch(now, 10)).executing.get(userId)).toBe(1);
    await runner.retryLater(busy.id, "chat_busy");
    await prisma.scheduledTaskOccurrence.update({ data: { startedAt: new Date(now.getTime() - 31 * 60_000) }, where: { id: busy.id } });
    expect(await runner.expirePending(now, 10)).toMatchObject([{ occurrenceId: busy.id, reasonCode: "chat_busy", state: "SKIPPED" }]);

    await prisma.scheduledTaskOccurrence.createMany({ data: Array.from({ length: SCHEDULED_TASK_OCCURRENCE_RETENTION + 5 }, (_value, index) => ({
      finishedAt: now, scheduledFor: new Date(now.getTime() - (index + 100) * 86_400_000), state: "COMPLETED" as const,
      taskId: created.id, trigger: "schedule", userId
    })) });
    await owners.requestRun(userId, created.id, now);
    expect(await prisma.scheduledTaskOccurrence.count({ where: { taskId: created.id } })).toBe(SCHEDULED_TASK_OCCURRENCE_RETENTION);
    expect(await prisma.scheduledTaskOccurrence.count({ where: { state: "PENDING", taskId: created.id } })).toBe(1);
    await expect(owners.requestRun(userId, created.id, new Date(now.getTime() + 1))).rejects.toEqual(new ScheduledTaskError("scheduled_task_running"));
    await expect(owners.requestRun(await owner(), created.id, now)).rejects.toEqual(new ScheduledTaskError("scheduled_task_not_found"));
  });

  it("claims a result email once and only for a verified address with SMTP active", async () => {
    const userId = await owner();
    const created = await task(userId, null, { emailNotify: true });
    const settled = await prisma.scheduledTaskOccurrence.create({ data: { finishedAt: new Date(), scheduledFor: new Date(),
      state: "COMPLETED", taskId: created.id, trigger: "manual", userId } });
    const smtp = await prisma.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
    if (!smtp?.enabled || smtp.activeConfig === null) {
      expect(await runner.claimNotification(settled.id, new Date())).toBeNull();
      return;
    }
    expect(await runner.claimNotification(settled.id, new Date())).toBeNull();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await prisma.authIdentity.create({ data: { emailVerifiedAt: new Date(), normalizedEmail: user.email!.toLowerCase(),
      provider: "password", providerAccountId: user.email!.toLowerCase(), userId } });
    expect(await runner.claimNotification(settled.id, new Date())).toMatchObject({ email: user.email, state: "COMPLETED",
      title: "Synthetic brief", trigger: "manual" });
    expect(await runner.claimNotification(settled.id, new Date())).toBeNull();
  });
});
