// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { SMTP_CONTROL_ID } from "../email/repository";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
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
const hourly = { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } satisfies ScheduledTaskSchedule;

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
  return { occurrenceId, previousResult: null, relevantMcpServerIds: null, taskGeneration: created.generation, taskId: created.id,
    taskRevision: created.revision, ...overrides };
}

/** A send into an existing chat, as the send handler hands it to run creation. */
async function runInput(userId: string, chatId: string, scheduledOccurrence?: ScheduledOccurrenceAdmission,
  extra: Partial<CreateRunInput> = {}): Promise<CreateRunInput> {
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
    userId,
    ...extra
  };
}

/** Content-free receipts of MCP calls the run's Workspace code made, as the code gateway leaves them. */
async function codeReceipts(runId: string, chatId: string,
  receipts: readonly Readonly<{ errorCode?: string; serverId: string; state: "complete" | "error" | "unknown" }>[]) {
  const session = await prisma.workspaceSession.upsert({ where: { chatId }, update: {}, create: { chatId,
    expiresAt: new Date(Date.now() + 600_000), imageRef: "aiqsa-workspace:0.1.32", internetEnabled: true, policyRevision: 1,
    sandboxName: `code-${randomUUID()}` } });
  await prisma.workspaceRunBinding.create({ data: { imageRef: session.imageRef, internetEnabled: true, mcpVersion: "0.6.16",
    modelRunId: runId, outputDirectory: `/workspace/output/${runId}`, policyRevision: 1, runtimeVersion: "0.6.16",
    toolCatalogHash: "a".repeat(64), toolDefinitions: [], workspaceSessionId: session.id } });
  await prisma.workspaceCodeGrant.create({ data: { modelRunId: runId, workspaceSessionId: session.id } });
  const call = await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: runId, ordinal: 90,
    providerCallId: `code-${randomUUID()}`, roundIndex: 0, state: "complete", toolName: "workspace__sandbox_shell" } });
  const invocationId = randomUUID().replaceAll("-", "");
  await prisma.workspaceCodeInvocation.create({ data: { closedAt: new Date(), id: invocationId, kind: "command",
    modelRunId: runId, state: "closed", toolCallId: call.id } });
  await prisma.workspaceCodeCall.createMany({ data: receipts.map((receipt, sequence) => ({ argumentHash: "c".repeat(64),
    errorCode: receipt.errorCode ?? null, invocationId, modelRunId: runId, sequence, serverId: receipt.serverId,
    settledAt: new Date(), state: receipt.state, toolName: `mcp_${receipt.serverId}_tool` })) });
}

afterEach(async () => {
  const ids = users.splice(0);
  const chats = await prisma.chat.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await prisma.modelRun.deleteMany({ where: { userId: { in: ids }, workspaceRunBinding: { isNot: null } } });
  await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chats.map((chat) => chat.id) } } });
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  // Memory-mode chats run the Memory source lifecycle, which may leave purge obligations.
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
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

  it("admits every later answer to a scheduled task's prompt without Personal Memory, in its chat and branch copies", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const chat = await personalChat(userId, "NORMAL");
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      scheduledFor: new Date(), startedAt: new Date(), taskId: created.id, trigger: "manual", userId
    } });
    // The prompt may have been written by the model, an explicit Memory command included.
    const command = textMessageContent("/memory forget everything");
    const base = await runInput(userId, chat.id, origin(occurrence.id, created));
    const input: CreateRunInput = { ...base, content: command, normalizedRequest: { ...base.normalizedRequest, content: command } };
    const run = await runs.createRun(input);
    // Run creation marks the prompt it posts, beside the run's scheduled origin.
    expect(await prisma.message.findUniqueOrThrow({ where: { id: run.userMessageId } }))
      .toMatchObject({ role: "user", scheduledTaskPrompt: true });
    const cancel = (runId: string) =>
      runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId, userId });
    await cancel(run.runId);
    /** A Regenerate of the answer `assistantMessageId` to `userMessageId`, as the regenerate handler hands it to run creation. */
    const regenerate = async (chatId: string, userMessageId: string, assistantMessageId: string) => {
      const regenerated = await runs.createRegenerationRun({
        chatId, modelId: input.modelId, normalizedRequest: { ...input.normalizedRequest, chatId },
        preSendAssistantMessageId: assistantMessageId, provider: input.provider, providerAdmissionPlan: input.providerAdmissionPlan,
        providerRequestPreview: input.providerRequestPreview, userId, userMessageId
      });
      // An ordinary run, dispatchable at once: no Memory attempt or binding, so no synchronous command either.
      expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: regenerated.runId } }))
        .toMatchObject({ scheduledTaskId: null, status: "streaming", userMessageId });
      expect(await prisma.memoryRetrievalAttempt.count({ where: { modelRunId: regenerated.runId } })).toBe(0);
      expect(await prisma.modelRunMemoryBinding.count({ where: { modelRunId: regenerated.runId } })).toBe(0);
      await cancel(regenerated.runId);
      return regenerated;
    };
    /** A branch from `sourceMessageId`: its copies carry no runs, the copied prompt keeps its mark. */
    const branch = async (sourceMessageId: string) => {
      const branched = await createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({ sourceMessageId, userId });
      if (!branched?.activeLeafMessageId) throw new Error("scheduled_runner_test_branch_missing");
      const prompt = await prisma.message.findFirstOrThrow({ where: { chatId: branched.id, role: "user" } });
      expect(prompt.scheduledTaskPrompt).toBe(true);
      expect(await prisma.modelRun.count({ where: { chatId: branched.id } })).toBe(0);
      return { answerId: branched.activeLeafMessageId, chatId: branched.id, promptId: prompt.id };
    };

    // A Regenerate in the task's chat.
    const inChat = await regenerate(chat.id, run.userMessageId, run.assistantMessageId);
    // One in a branch copy, and one in a branch of that branch.
    const first = await branch(inChat.assistantMessageId);
    const inBranch = await regenerate(first.chatId, first.promptId, first.answerId);
    const second = await branch(inBranch.assistantMessageId);
    await regenerate(second.chatId, second.promptId, second.answerId);
    expect(await prisma.memoryJob.count({ where: { kind: "MEMORY_COMMAND", userId } })).toBe(0);
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
      runId: run.runId, sourceAlert: false, sourcesIncomplete: false, state: "FAILED", taskPaused: true }]);
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

  it("freezes a run's missing sources on its occurrence and pauses after three incomplete results", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { toolsEnabled: true });
    const chat = await personalChat(userId);
    const missing = [{ name: "Synthetic Mail", reason: "mcp_reauthorization_required" as const, relied: true, serverId: "server-mail" }];
    const now = new Date();
    const settlements = [];
    for (let index = 0; index < 3; index += 1) {
      const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
      const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + index),
        startedAt: new Date(), taskId: created.id, trigger: "schedule", userId } });
      const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, current),
        { scheduledUnavailableSources: missing }));
      expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }))
        .toMatchObject({ state: "RUNNING", unavailableSources: missing });
      await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.runId } });
      settlements.push(await runner.settleLinked(occurrence.id, now));
    }
    // Each result completed; the first of the streak is its one alert and the third pauses the task.
    expect(settlements.map((settlement) => [settlement?.state, settlement?.sourcesIncomplete, settlement?.sourceAlert, settlement?.taskPaused]))
      .toEqual([["COMPLETED", true, true, false], ["COMPLETED", true, false, false], ["COMPLETED", true, false, true]]);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      consecutiveFailures: 0, consecutiveIncompleteRuns: 3, nextRunAt: null, pauseReason: "source_unavailable", status: "PAUSED"
    });
    // Run history shows the source by name and reason, never its identifier.
    const detail = await owners.detail(userId, created.id);
    expect(detail?.recentRuns[0]?.unavailableSources).toEqual([{ name: "Synthetic Mail", reason: "mcp_reauthorization_required" }]);
    // An owner edit (here resuming) ends the streak.
    const { chatMode, emailNotify, kind, memoryEnabled, modelId, pinnedSkillIds, prompt, provider, revision, schedule, searchEnabled,
      timeZone, title, toolsEnabled, workspaceEnabled } = detail!.task;
    await owners.update(userId, created.id, {
      draft: { chatMode, emailNotify, kind, memoryEnabled, modelId, pinnedSkillIds, prompt, provider, schedule, searchEnabled, timeZone,
        title, toolsEnabled, workspaceEnabled },
      expectedRevision: revision, nextRunAt: new Date(Date.now() + 3_600_000), promptUrls: "keep", status: "active"
    });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } }))
      .toMatchObject({ consecutiveIncompleteRuns: 0, pauseReason: null, status: "ACTIVE" });
  });

  it("judges a source relevant by the previous shown result's calls and the gaps it relied on", async () => {
    const userId = await owner();
    const chat = await personalChat(userId);
    const created = await task(userId, null, { toolsEnabled: true });
    const previous = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(previous.id, created), { scheduledUnavailableSources: [
      { name: "Synthetic Mail", reason: "mcp_reauthorization_required", relied: true, serverId: "server-mail" },
      // Counted only because a first run had nothing to judge by: never carried.
      { name: "Synthetic Notes", reason: "mcp_server_unavailable", relied: false, serverId: "server-notes" }
    ] }));
    // The run loaded two servers' tools through Auto and called one of them.
    const accepted = await prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } });
    await prisma.modelRun.update({ data: { normalizedRequest: { ...(accepted.normalizedRequest as object), mcp: { version: 1, servers: [],
      tools: [{ namespacedName: "mcp_tracker_read_1", originalName: "read", serverId: "server-tracker", serverName: "Tracker" },
        { namespacedName: "mcp_wiki_read_1", originalName: "read", serverId: "server-wiki", serverName: "Wiki" }] } },
    status: "complete" }, where: { id: run.runId } });
    await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: run.runId, ordinal: 0, providerCallId: "call-1",
      roundIndex: 0, state: "complete", toolName: "mcp_tracker_read_1" } });
    await runner.settleLinked(previous.id, new Date());
    const next = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + 1), taskId: created.id,
      trigger: "manual", userId } });
    expect([...(await runner.loadExecution(next.id))!.relevantMcpServerIds!].sort()).toEqual(["server-mail", "server-tracker"]);
    // Servers the result's Workspace code called are relied on like servers its model called.
    await codeReceipts(run.runId, chat.id, [{ serverId: "server-gitlab", state: "complete" }]);
    expect([...(await runner.loadExecution(next.id))!.relevantMcpServerIds!].sort())
      .toEqual(["server-gitlab", "server-mail", "server-tracker"]);
    // Tools off: no relevance is read. A previous result whose run is gone leaves nothing to judge by.
    await prisma.scheduledTask.update({ data: { toolsEnabled: false }, where: { id: created.id } });
    expect((await runner.loadExecution(next.id))!.relevantMcpServerIds).toBeNull();
    await prisma.scheduledTask.update({ data: { toolsEnabled: true }, where: { id: created.id } });
    await prisma.modelRun.delete({ where: { id: run.runId } });
    expect((await runner.loadExecution(next.id))!.relevantMcpServerIds).toBeNull();
    // The prompt's page-reading snapshot is read with the task's revision.
    const digest = "c".repeat(64);
    await prisma.scheduledTask.update({ data: { promptUrlDigests: [digest] }, where: { id: created.id } });
    expect((await runner.loadExecution(next.id))!.task).toMatchObject({ promptUrlDigests: [digest], revision: created.revision });
  });

  it("finds runs past their deadline by the run's own scheduled origin, counted from admission", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const chat = await personalChat(userId);
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created)));
    const ordinary = await runs.createRun(await runInput(userId, (await personalChat(userId)).id));
    const now = new Date();
    expect(await runner.overdueRuns(now, 10)).toEqual([]);
    const admitted = new Date(now.getTime() - 31 * 60_000);
    await prisma.modelRun.updateMany({ data: { createdAt: admitted }, where: { id: { in: [run.runId, ordinary.runId] } } });
    expect(await runner.overdueRuns(now, 10)).toEqual([{ runId: run.runId, userId }]);
    // The deadline outlives the task and its history.
    await prisma.scheduledTask.delete({ where: { id: created.id } });
    expect(await runner.overdueRuns(now, 10)).toEqual([{ runId: run.runId, userId }]);
    await runs.cancelRun({ payload: { code: "run_deadline", message: "Scheduled run stopped at its time limit" }, runId: run.runId, userId });
    expect(await prisma.modelRun.findUniqueOrThrow({ where: { id: run.runId } })).toMatchObject({
      errorPayload: { code: "run_deadline" }, status: "cancelled"
    });
    expect(await runner.overdueRuns(now, 10)).toEqual([]);
  });

  it("never lets a scheduled run change an existing chat's Workspace switch", async () => {
    const userId = await owner();
    const created = await task(userId, null);
    const chat = await prisma.chat.update({ data: { workspaceEnabled: true }, where: { id: (await personalChat(userId)).id } });
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(), startedAt: new Date(),
      taskId: created.id, trigger: "manual", userId } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created), { workspaceEnabled: false }));
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ workspaceEnabled: true });
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: run.runId, userId });
    // The owner's own message still sets the switch as before.
    await runs.createRun(await runInput(userId, chat.id, undefined, { workspaceEnabled: false }));
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ workspaceEnabled: false });
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
      title: "Synthetic brief", trigger: "manual", unavailableSources: [] });
    expect(await runner.claimNotification(settled.id, new Date())).toBeNull();
  });
});

describe("persisted monitoring checks", () => {
  let instants = 0;
  async function check(userId: string, chatId: string, trigger: "manual" | "schedule" = "manual") {
    const current = await prisma.scheduledTask.findFirstOrThrow({ where: { userId } });
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      scheduledFor: new Date(Date.now() + (instants += 1)), startedAt: new Date(), taskId: current.id, trigger, userId
    } });
    const run = await runs.createRun(await runInput(userId, chatId, origin(occurrence.id, current, { monitoring: true })));
    return { occurrence, run };
  }
  async function finish(admitted: Awaited<ReturnType<typeof check>>, verdict: "goal_reached" | "no_update" | "update" | null, now: Date) {
    if (verdict) expect(await runs.recordMonitoringVerdict!({ runId: admitted.run.runId, userId: admitted.occurrence.userId, verdict })).toBe(true);
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: admitted.run.runId } });
    return runner.settleLinked(admitted.occurrence.id, now);
  }
  const occurrenceOf = (id: string) => prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id } });
  const outcomeOf = async (runId: string) => (await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } })).scheduledOutcome;

  it("records a report on its run's running occurrence only, the last report winning", async () => {
    const userId = await owner();
    await task(userId, null, { kind: "MONITORING" });
    const chat = await personalChat(userId);
    const first = await check(userId, chat.id);
    expect(await occurrenceOf(first.occurrence.id)).toMatchObject({ taskRevision: 1, verdict: null });
    expect(await runs.recordMonitoringVerdict!({ runId: first.run.runId, userId, verdict: "update" })).toBe(true);
    // Recovery may record the same or a later report again: the last one wins.
    expect(await runs.recordMonitoringVerdict!({ runId: first.run.runId, userId, verdict: "no_update" })).toBe(true);
    expect((await occurrenceOf(first.occurrence.id)).verdict).toBe("no_update");
    // No other owner's run, and nothing once the occurrence settled, can write a report.
    expect(await runs.recordMonitoringVerdict!({ runId: first.run.runId, userId: await owner(), verdict: "goal_reached" })).toBe(false);
    await finish(first, null, new Date());
    expect(await runs.recordMonitoringVerdict!({ runId: first.run.runId, userId, verdict: "goal_reached" })).toBe(false);
    expect((await occurrenceOf(first.occurrence.id)).verdict).toBe("no_update");
    await expect(prisma.scheduledTaskOccurrence.update({ data: { verdict: "maybe" }, where: { id: first.occurrence.id } }))
      .rejects.toThrow();
  });

  it("shows the first check, keeps later checks without news silent and out of the baseline, and keeps outcomes on the runs", async () => {
    const userId = await owner();
    const created = await task(userId, null, { kind: "MONITORING" });
    const chat = await personalChat(userId);
    const now = new Date();
    const first = await check(userId, chat.id);
    expect(await finish(first, "no_update", now)).toMatchObject({ reasonCode: "baseline", state: "COMPLETED", taskPaused: false });
    expect(await occurrenceOf(first.occurrence.id)).toMatchObject({ reasonCode: "baseline", unseenAt: now });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ baselineRunId: first.run.runId });
    expect(await outcomeOf(first.run.runId)).toBe("baseline");

    const quiet = await check(userId, chat.id);
    expect(await finish(quiet, "no_update", now)).toMatchObject({ reasonCode: "no_update", state: "COMPLETED" });
    expect(await occurrenceOf(quiet.occurrence.id)).toMatchObject({ reasonCode: "no_update", unseenAt: null });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ baselineRunId: first.run.runId });
    expect(await outcomeOf(quiet.run.runId)).toBe("no_update");

    const news = await check(userId, chat.id);
    expect(await finish(news, "update", now)).toMatchObject({ reasonCode: "update" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ baselineRunId: news.run.runId });

    // A standard task's run keeps no check outcome.
    await prisma.scheduledTask.update({ data: { kind: "STANDARD" }, where: { id: created.id } });
    const plain = await check(userId, chat.id);
    expect(await finish(plain, null, now)).toMatchObject({ reasonCode: null, state: "COMPLETED" });
    expect(await outcomeOf(plain.run.runId)).toBeNull();
  });

  it("settles a check whose code could not reach a source as could_not_check, never as a hidden no_update", async () => {
    const userId = await owner();
    await task(userId, null, { kind: "MONITORING", toolsEnabled: true });
    const chat = await personalChat(userId);
    const now = new Date();
    expect(await finish(await check(userId, chat.id), "no_update", now)).toMatchObject({ reasonCode: "baseline" });
    const withCatalog = async (runId: string) => {
      const accepted = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
      await prisma.modelRun.update({ where: { id: runId }, data: { normalizedRequest: { ...(accepted.normalizedRequest as object),
        mcpDiscovery: { catalog: { servers: [{ description: "", namespace: "gitlab", revisionId: "revision", serverId: "server-gitlab",
          serverName: "Synthetic GitLab", tools: [] }], version: 1 }, epochs: [], version: 2 } } } });
    };
    // GitLab is reached only through the Skill's code, which found it needing a new sign-in.
    const blind = await check(userId, chat.id);
    await withCatalog(blind.run.runId);
    await codeReceipts(blind.run.runId, chat.id, [{ errorCode: "authorization_required", serverId: "server-gitlab", state: "error" }]);
    expect(await finish(blind, "no_update", now)).toMatchObject({ reasonCode: "could_not_check", sourcesIncomplete: true,
      state: "COMPLETED" });
    expect(await occurrenceOf(blind.occurrence.id)).toMatchObject({ unseenAt: now, unavailableSources: [
      { name: "Synthetic GitLab", reason: "mcp_reauthorization_required", relied: true, serverId: "server-gitlab" }] });
    expect(await outcomeOf(blind.run.runId)).toBe("could_not_check");
    // A transient refusal the code recovered from, or a tool's own error, is no missing source.
    const recovered = await check(userId, chat.id);
    await codeReceipts(recovered.run.runId, chat.id, [
      { errorCode: "upstream_unavailable", serverId: "server-gitlab", state: "error" },
      { serverId: "server-gitlab", state: "complete" },
      { errorCode: "upstream_error", serverId: "server-wiki", state: "error" }
    ]);
    expect(await finish(recovered, "no_update", now)).toMatchObject({ reasonCode: "no_update", sourcesIncomplete: false });
    expect((await occurrenceOf(recovered.occurrence.id)).unavailableSources).toBeNull();
  });

  it("pauses after three scheduled checks in a row that never reported", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { kind: "MONITORING", consecutiveMissingVerdicts: 2 });
    const chat = await personalChat(userId);
    const unreported = await check(userId, chat.id, "schedule");
    expect(await finish(unreported, null, new Date())).toMatchObject({ reasonCode: "unreported", state: "COMPLETED", taskPaused: true });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      consecutiveMissingVerdicts: 3, nextRunAt: null, pauseReason: "verdict_missing", revision: 2, status: "PAUSED"
    });
    // Shown anyway: an update is never hidden by mistake.
    expect((await occurrenceOf(unreported.occurrence.id)).unseenAt).not.toBeNull();
  });

  it("completes the task on a reached goal only under the revision its run was accepted under", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { kind: "MONITORING" });
    const chat = await personalChat(userId);
    const edited = await check(userId, chat.id);
    // An owner edit after admission wins: the goal is shown as an update and the task stays active.
    await prisma.scheduledTask.update({ data: { revision: { increment: 1 }, title: "Renamed" }, where: { id: created.id } });
    expect(await finish(edited, "goal_reached", new Date())).toMatchObject({ reasonCode: "update" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } }))
      .toMatchObject({ completionReason: null, revision: 2, status: "ACTIVE" });

    const reached = await check(userId, chat.id);
    expect(await finish(reached, "goal_reached", new Date())).toMatchObject({ reasonCode: "goal_reached", state: "COMPLETED" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      completionReason: "goal_reached", nextRunAt: null, pauseReason: null, revision: 3, status: "COMPLETED"
    });
    expect((await occurrenceOf(reached.occurrence.id)).unseenAt).not.toBeNull();
    // Resume continues from now and clears why it completed.
    const completed = await owners.get(userId, created.id);
    const resumed = await owners.update(userId, created.id, { draft: { ...completed!, kind: "monitoring" }, expectedRevision: 3,
      nextRunAt: new Date(Date.now() + 3_600_000), promptUrls: "keep", status: "active" });
    expect(resumed).toMatchObject({ completionReason: null, kind: "monitoring", status: "active" });
  });
});
