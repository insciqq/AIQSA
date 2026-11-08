// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
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
import { SCHEDULED_TASK_EMAIL_WINDOW_MS } from "./notifications";
import { SCHEDULED_TASK_OCCURRENCE_RETENTION, pausingOutcome, type MonitoringVerdict } from "./runnerPolicy";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import {
  createPrismaScheduledTaskStore,
  readScheduledTaskEmailAvailability,
  scheduledTaskScheduleColumns,
  ScheduledTaskError
} from "./store";

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
function origin(occurrenceId: string, created: Readonly<{ chatEpoch?: number; generation: number; id: string; revision: number }>,
  overrides: Partial<ScheduledOccurrenceAdmission> = {}): ScheduledOccurrenceAdmission {
  return { occurrenceId, previousResult: null, relevantMcpServerIds: null, taskChatEpoch: created.chatEpoch ?? 0,
    taskGeneration: created.generation, taskId: created.id, taskRevision: created.revision, ...overrides };
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
    normalizedRequest: { attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
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
    toolCatalogHash: "a".repeat(64), toolDefinitions: [{ description: "Fixture", inputSchema: { type: "object" },
      namespacedName: "workspace__sandbox_shell", originalName: "sandbox_shell" }], workspaceSessionId: session.id } });
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

  it("fails a completed run for a sign-in only when its agent needed one nobody could do, never for a corrected call", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000));
    const chat = await personalChat(userId);
    let instant = 0;
    async function settled(reason: string, error: string) {
      const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
      const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(Date.now() + ++instant),
        startedAt: new Date(), taskId: created.id, trigger: "manual", userId } });
      const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, current)));
      // The handoff call's row as the tool batch stores it, then the run's answer.
      await prisma.modelRunToolCall.create({ data: { arguments: { message: "Synthetic handoff", reason }, modelRunId: run.runId,
        ordinal: 0, providerCallId: `handoff-${randomUUID()}`, result: { callId: "call-0", content: [{ type: "json",
          value: { error, message: "Synthetic" } }], name: "browser_handoff", status: "error" }, roundIndex: 0, state: "error",
        toolName: "browser_handoff" } });
      await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.runId } });
      return runner.settleLinked(occurrence.id, new Date());
    }
    // A malformed call the model then corrected, and a consent nobody could give: the run's own outcome stands.
    expect(await settled("sign_in", "browser_handoff_invalid")).toMatchObject({ state: "COMPLETED" });
    expect(await settled("consent", "browser_handoff_unavailable")).toMatchObject({ state: "COMPLETED" });
    expect(await settled("verification_code", "browser_handoff_unavailable"))
      .toMatchObject({ reasonCode: "browser_sign_in_required", state: "FAILED" });
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
    const { chatMode, emailNotify, historyRetentionDays, kind, memoryEnabled, modelId, pinnedSkillIds, prompt, provider, revision, schedule, searchEnabled,
      scheduleEnabled, telegramNotify, timeZone, title, toolsEnabled, webhookEnabled, workspaceEnabled } = detail!.task;
    await owners.update(userId, created.id, {
      draft: { chatMode, emailNotify, historyRetentionDays, kind, memoryEnabled, modelId, pinnedSkillIds, prompt, provider, schedule, searchEnabled, timeZone,
        scheduleEnabled, telegramNotify, title, toolsEnabled, webhookEnabled, workspaceEnabled },
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

  it("claims a due result email once exactly when the editor offers email, an LDAP account without a verified identity included",
    async () => {
      const userId = await owner();
      // An LDAP sign-in creates its identity unverified while the account keeps the address the directory is trusted for.
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      await prisma.authIdentity.create({ data: { normalizedEmail: user.email!.toLowerCase(), provider: "ldap",
        providerAccountId: `uid=${userId}`, source: "ldap:synthetic", userId } });
      const created = await task(userId, null, { emailNotify: true });
      const now = new Date();
      const settledAt = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
      const due = await prisma.scheduledTaskOccurrence.create({ data: { emailDueAt: now, finishedAt: now, scheduledFor: settledAt(1),
        state: "COMPLETED", taskId: created.id, trigger: "manual", userId } });
      // A result the previous release settled carries no due email and is never claimed.
      const legacy = await prisma.scheduledTaskOccurrence.create({ data: { finishedAt: now, scheduledFor: settledAt(2),
        state: "COMPLETED", taskId: created.id, trigger: "manual", userId } });
      const offered = await readScheduledTaskEmailAvailability(prisma, userId);
      const smtp = await prisma.smtpControl.findUnique({ where: { id: SMTP_CONTROL_ID } });
      expect(offered).toBe(Boolean(smtp?.enabled && smtp.activeConfig !== null));
      expect(await runner.listDueNotifications(now, 10)).toContain(due.id);
      const claimed = await runner.claimNotification(due.id, now);
      expect(claimed !== null).toBe(offered);
      if (claimed) {
        expect(claimed).toMatchObject({ email: user.email, state: "COMPLETED", title: "Synthetic brief", trigger: "manual",
          unavailableSources: [] });
      }
      // Claimed or no longer sendable, it stops being due either way, and is never claimed twice.
      expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: due.id } }))
        .toMatchObject({ emailDueAt: null, notifiedAt: offered ? now : null });
      expect(await runner.claimNotification(due.id, now)).toBeNull();
      expect(await runner.listDueNotifications(now, 10)).not.toContain(due.id);
      expect(await runner.claimNotification(legacy.id, now)).toBeNull();
      expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ notifiedAt: null });
    });

  it("offers and claims no email for an account without an address", async () => {
    const userId = await owner();
    await prisma.user.update({ data: { email: null }, where: { id: userId } });
    const created = await task(userId, null, { emailNotify: true });
    const now = new Date();
    const due = await prisma.scheduledTaskOccurrence.create({ data: { emailDueAt: now, finishedAt: now, scheduledFor: now,
      state: "FAILED", taskId: created.id, trigger: "manual", userId } });
    expect(await readScheduledTaskEmailAvailability(prisma, userId)).toBe(false);
    expect(await runner.claimNotification(due.id, now)).toBeNull();
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: due.id } }))
      .toMatchObject({ emailDueAt: null, notifiedAt: null });
  });

  it("writes a notifying settlement's Telegram outbox row and due email in the settlement itself, and a quiet one writes neither",
    async () => {
      const userId = await owner();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      const notifying = await task(userId, tomorrow, { emailNotify: true, telegramNotify: true });
      const now = new Date();
      const failing = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(now.getTime() - 60_000),
        taskId: notifying.id, trigger: "schedule", userId } });
      // A pausing failure is news: no tick, wake or later write is needed for its notifications to exist.
      expect(await runner.settlePending(failing.id, pausingOutcome("model_unavailable"), now, notifying.revision))
        .toMatchObject({ state: "FAILED", taskPaused: true });
      expect(await prisma.telegramScheduledDelivery.findMany({ where: { occurrenceId: failing.id } }))
        .toEqual([expect.objectContaining({ attempts: 0, nextAttemptAt: now, state: "pending", userId })]);
      expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: failing.id } }))
        .toMatchObject({ emailDueAt: now, notifiedAt: null, state: "FAILED" });
      expect(await runner.listDueNotifications(now, 500)).toContain(failing.id);
      // Past its window a due email is never picked up.
      expect(await runner.listDueNotifications(new Date(now.getTime() + SCHEDULED_TASK_EMAIL_WINDOW_MS), 500))
        .not.toContain(failing.id);

      const quiet = await task(userId, tomorrow, { emailNotify: true, telegramNotify: true });
      const busy = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(now.getTime() - 60_000),
        taskId: quiet.id, trigger: "schedule", userId } });
      expect(await runner.settlePending(busy.id, { reasonCode: "chat_busy", state: "SKIPPED" }, now))
        .toMatchObject({ state: "SKIPPED", taskPaused: false });
      expect(await prisma.telegramScheduledDelivery.count({ where: { occurrenceId: busy.id } })).toBe(0);
      expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: busy.id } })).toMatchObject({ emailDueAt: null });

      // A notifying settlement of a task with both switches off writes neither.
      const silent = await task(userId, tomorrow, { emailNotify: false, telegramNotify: false });
      const silentFailure = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(now.getTime() - 60_000),
        taskId: silent.id, trigger: "schedule", userId } });
      expect(await runner.settlePending(silentFailure.id, pausingOutcome("model_unavailable"), now, silent.revision))
        .toMatchObject({ taskPaused: true });
      expect(await prisma.telegramScheduledDelivery.count({ where: { occurrenceId: silentFailure.id } })).toBe(0);
      expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: silentFailure.id } }))
        .toMatchObject({ emailDueAt: null });
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
  async function finish(admitted: Awaited<ReturnType<typeof check>>, verdict: MonitoringVerdict | null, now: Date) {
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
    // GitLab is reached only through the Skill's code, which found it needing a new sign-in. A scheduled
    // check's first incomplete result raises the source alert, so it is news rather than a hidden result.
    const blind = await check(userId, chat.id, "schedule");
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

  it("settles a check whose tool search could not load a source as could_not_check, unless a later search loaded it", async () => {
    const userId = await owner();
    await task(userId, null, { kind: "MONITORING", toolsEnabled: true });
    const chat = await personalChat(userId);
    const now = new Date();
    expect(await finish(await check(userId, chat.id), "no_update", now)).toMatchObject({ reasonCode: "baseline" });
    const withDiscovery = async (runId: string, loadedServerIds: readonly string[]) => {
      const accepted = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
      await prisma.modelRun.update({ where: { id: runId }, data: { normalizedRequest: { ...(accepted.normalizedRequest as object),
        mcp: { servers: loadedServerIds.map((serverId) => ({ fingerprint: "fingerprint", revisionId: "revision", serverId,
          serverName: "Synthetic GitLab" })), tools: [], version: 1 },
        mcpDiscovery: { catalog: { servers: [{ description: "", namespace: "gitlab", revisionId: "revision", serverId: "server-gitlab",
          serverName: "Synthetic GitLab", tools: [] }], version: 1 }, epochs: [{ epoch: 1, goal: "gitlab issues",
          modelRunToolCallId: "synthetic-find-tools", roundIndex: 1, toolIds: [],
          unavailable: [{ reason: "mcp_reauthorization_required", serverId: "server-gitlab" }] }], version: 2 } } } });
    };
    // The model searched for GitLab's tools and found it needing a new sign-in: the answer
    // continued without them, so the check could not check rather than report a hidden no_update.
    const blind = await check(userId, chat.id, "schedule");
    await withDiscovery(blind.run.runId, []);
    expect(await finish(blind, "no_update", now)).toMatchObject({ reasonCode: "could_not_check", sourcesIncomplete: true,
      state: "COMPLETED" });
    expect(await occurrenceOf(blind.occurrence.id)).toMatchObject({ unavailableSources: [
      { name: "Synthetic GitLab", reason: "mcp_reauthorization_required", relied: true, serverId: "server-gitlab" }] });
    // A later search of the same run loaded it: no missing source.
    const recovered = await check(userId, chat.id);
    await withDiscovery(recovered.run.runId, ["server-gitlab"]);
    expect(await finish(recovered, "no_update", now)).toMatchObject({ reasonCode: "no_update", sourcesIncomplete: false });
    expect((await occurrenceOf(recovered.occurrence.id)).unavailableSources).toBeNull();
  });

  it("settles a check whose direct MCP call could not reach its server as could_not_check, never as a hidden no_update", async () => {
    const userId = await owner();
    await task(userId, null, { kind: "MONITORING", toolsEnabled: true });
    const chat = await personalChat(userId);
    const now = new Date();
    expect(await finish(await check(userId, chat.id), "no_update", now)).toMatchObject({ reasonCode: "baseline" });
    // The run's frozen plan names each called tool's server (its final snapshot after any tool search).
    const withPlan = async (runId: string) => {
      const accepted = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
      const server = (serverId: string, serverName: string) => ({ fingerprint: "fingerprint", revisionId: "revision", serverId, serverName });
      const tool = (namespacedName: string, serverId: string, serverName: string) => ({ annotations: { readOnlyHint: true },
        definitionHash: "d".repeat(64), description: null, inputSchema: { type: "object" }, namespacedName, originalName: namespacedName,
        serverId, serverName });
      await prisma.modelRun.update({ where: { id: runId }, data: { normalizedRequest: { ...(accepted.normalizedRequest as object),
        mcp: { servers: [server("server-github", "Synthetic GitHub"), server("server-wiki", "Synthetic Wiki")],
          tools: [tool("github__get_pull_request", "server-github", "Synthetic GitHub"), tool("wiki__search", "server-wiki", "Synthetic Wiki")],
          version: 1 } } } });
    };
    // A failure the engine records after the batch's retries, with its closed reason; a server's own result keeps its preview.
    const failure = (reason: string, error: string) => ({ callId: "call", name: "tool", status: "error",
      content: [{ type: "json", value: { error, message: "Synthetic failure guidance.", reason } }] });
    const returned = (status: "complete" | "error", value: Prisma.InputJsonObject) => ({ callId: "call", name: "tool", status,
      content: [{ type: "json", value }], rawPreview: { isError: status === "error", unsupportedContentTypes: [] } });
    const directCalls = (runId: string,
      rows: readonly Readonly<{ result: Prisma.InputJsonObject; state: "complete" | "error"; toolName: string }>[]) =>
      prisma.modelRunToolCall.createMany({ data: rows.map((row, ordinal) => ({ arguments: {}, completedAt: new Date(), modelRunId: runId,
        ordinal, providerCallId: `direct-${randomUUID()}`, result: row.result, roundIndex: 1, state: row.state, toolName: row.toolName })) });

    // GitHub never answered in time, and the model reported nothing changed: a scheduled check's first incomplete result
    // raises the source alert, so it is news rather than a hidden result.
    const blind = await check(userId, chat.id, "schedule");
    await withPlan(blind.run.runId);
    await directCalls(blind.run.runId, [{ result: failure("timeout", "mcp_request_timeout"), state: "error", toolName: "github__get_pull_request" }]);
    expect(await finish(blind, "no_update", now)).toMatchObject({ reasonCode: "could_not_check", sourcesIncomplete: true,
      state: "COMPLETED" });
    expect(await occurrenceOf(blind.occurrence.id)).toMatchObject({ unseenAt: now, unavailableSources: [
      { name: "Synthetic GitHub", reason: "mcp_server_unavailable", relied: true, serverId: "server-github" }] });
    expect(await outcomeOf(blind.run.runId)).toBe("could_not_check");

    // A failure the same run recovered from, arguments the model got wrong and a tool's own error are no missing source,
    // even when the tool's own output imitates an engine failure.
    const checked = await check(userId, chat.id);
    await withPlan(checked.run.runId);
    await directCalls(checked.run.runId, [
      { result: failure("unavailable", "mcp_runtime_unavailable"), state: "error", toolName: "github__get_pull_request" },
      { result: returned("complete", { state: "open" }), state: "complete", toolName: "github__get_pull_request" },
      { result: failure("arguments_invalid", "mcp_call_arguments_invalid"), state: "error", toolName: "github__get_pull_request" },
      { result: returned("error", { error: "mcp_request_timeout", message: "Imitation.", reason: "timeout" }), state: "error",
        toolName: "wiki__search" }
    ]);
    expect(await finish(checked, "no_update", now)).toMatchObject({ reasonCode: "no_update", sourcesIncomplete: false });
    expect((await occurrenceOf(checked.occurrence.id)).unavailableSources).toBeNull();
  });

  it("settles a check whose model could not check as could_not_check: shown, never a baseline, pausing after three in a row", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { kind: "MONITORING" });
    const chat = await personalChat(userId);
    const now = new Date();
    const first = await check(userId, chat.id);
    expect(await finish(first, "update", now)).toMatchObject({ reasonCode: "baseline" });
    for (const streak of [1, 2, 3]) {
      const blind = await check(userId, chat.id, "schedule");
      // Every admitted source was there; the model's own page or tool failed.
      expect(await finish(blind, "could_not_check", now)).toMatchObject({ reasonCode: "could_not_check", sourceAlert: streak === 1,
        sourcesIncomplete: true, state: "COMPLETED", taskPaused: streak === 3 });
      // News only as the streak's alert and its pause.
      expect(await occurrenceOf(blind.occurrence.id)).toMatchObject({ unavailableSources: null, unseenAt: streak === 2 ? null : now,
        verdict: "could_not_check" });
      expect(await outcomeOf(blind.run.runId)).toBe("could_not_check");
    }
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      baselineRunId: first.run.runId, consecutiveIncompleteRuns: 3, consecutiveMissingVerdicts: 0, nextRunAt: null,
      pauseReason: "source_unavailable", revision: 2, status: "PAUSED"
    });
  });

  it("shows a check whose own context held no previous result as the starting point and makes it the next baseline", async () => {
    const userId = await owner();
    const created = await task(userId, null, { kind: "MONITORING" });
    const chat = await personalChat(userId);
    const now = new Date();
    const first = await check(userId, chat.id);
    expect(await finish(first, "update", now)).toMatchObject({ reasonCode: "baseline" });
    // What the run froze of its context with its instruction.
    const context = async (runId: string, shown: boolean) => {
      const accepted = await prisma.modelRun.findUniqueOrThrow({ where: { id: runId } });
      await prisma.modelRun.update({ where: { id: runId }, data: { normalizedRequest: { ...(accepted.normalizedRequest as object),
        monitoringPreviousResult: shown, monitoringVerdictTool: true } } });
    };
    // Compared with the previous result: nothing changed stays hidden.
    const compared = await check(userId, chat.id);
    await context(compared.run.runId, true);
    expect(await finish(compared, "no_update", now)).toMatchObject({ reasonCode: "no_update" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ baselineRunId: first.run.runId });
    // The baseline left the chat's active path (an owner Regenerate or a branch): the run was told no result was shown,
    // so its check is shown and becomes the basis the next check compares with.
    const contextless = await check(userId, chat.id);
    await context(contextless.run.runId, false);
    expect(await finish(contextless, "no_update", now)).toMatchObject({ reasonCode: "baseline", state: "COMPLETED" });
    expect(await occurrenceOf(contextless.occurrence.id)).toMatchObject({ reasonCode: "baseline", unseenAt: now });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } }))
      .toMatchObject({ baselineRunId: contextless.run.runId });
    expect(await outcomeOf(contextless.run.runId)).toBe("baseline");
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

  it("completes the task on a reached goal unless the owner paused it or changed its question meanwhile", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { kind: "MONITORING" });
    const chat = await personalChat(userId);
    const taskRow = () => prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
    const pause = () => prisma.scheduledTask.update({ data: { nextRunAt: null, revision: { increment: 1 }, status: "PAUSED" },
      where: { id: created.id } });
    const resume = () => prisma.scheduledTask.update({ data: { nextRunAt: new Date(Date.now() + 3_600_000), revision: { increment: 1 },
      status: "ACTIVE" }, where: { id: created.id } });

    // An owner pause after admission wins: the goal is shown as an update and the task stays paused.
    const paused = await check(userId, chat.id);
    await pause();
    expect(await finish(paused, "goal_reached", new Date())).toMatchObject({ reasonCode: "update" });
    expect(await taskRow()).toMatchObject({ completionReason: null, revision: 2, status: "PAUSED" });

    // So does a changed question: the result answers the old one and is no check of the new one.
    await resume();
    const reworded = await check(userId, chat.id);
    await prisma.scheduledTask.update({ data: { generation: { increment: 1 }, prompt: "Synthetic changed prompt",
      revision: { increment: 1 } }, where: { id: created.id } });
    expect(await finish(reworded, "goal_reached", new Date())).toMatchObject({ reasonCode: null, state: "COMPLETED" });
    expect(await taskRow()).toMatchObject({ completionReason: null, generation: 2, revision: 4, status: "ACTIVE" });

    // A save that kept the question, and a pause and resume, during the check leave the reached goal standing.
    const reached = await check(userId, chat.id);
    await prisma.scheduledTask.update({ data: { revision: { increment: 1 }, title: "Renamed" }, where: { id: created.id } });
    await pause();
    await resume();
    expect(await finish(reached, "goal_reached", new Date())).toMatchObject({ reasonCode: "goal_reached", state: "COMPLETED" });
    expect(await taskRow()).toMatchObject({
      completionReason: "goal_reached", nextRunAt: null, pauseReason: null, revision: 8, status: "COMPLETED"
    });
    expect((await occurrenceOf(reached.occurrence.id)).unseenAt).not.toBeNull();
    // Resume continues from now and clears why it completed.
    const completed = await owners.get(userId, created.id);
    const resumed = await owners.update(userId, created.id, { draft: { ...completed!, kind: "monitoring" }, expectedRevision: 8,
      nextRunAt: new Date(Date.now() + 3_600_000), promptUrls: "keep", status: "active" });
    expect(resumed).toMatchObject({ completionReason: null, kind: "monitoring", status: "active" });
  });
});

/** A Workspace binding for an accepted run, as Workspace admission creates it with the run. */
async function bindWorkspace(runId: string, chatId: string): Promise<void> {
  const session = await prisma.workspaceSession.upsert({ where: { chatId }, update: {}, create: { chatId,
    expiresAt: new Date(Date.now() + 600_000), imageRef: "aiqsa-workspace:0.1.32", internetEnabled: false, policyRevision: 1,
    sandboxName: `capacity-${randomUUID()}` } });
  await prisma.workspaceRunBinding.create({ data: { imageRef: session.imageRef, internetEnabled: false, mcpVersion: "0.6.16",
    modelRunId: runId, outputDirectory: `/workspace/output/${runId}`, policyRevision: 1, runtimeVersion: "0.6.16",
    toolCatalogHash: "a".repeat(64), toolDefinitions: [{ description: "Fixture", inputSchema: { type: "object" },
      namespacedName: "workspace__sandbox_shell", originalName: "sandbox_shell" }], workspaceSessionId: session.id } });
}

describe("persisted scheduled Workspace capacity", () => {
  it("holds a Workspace slot by a scheduled run with a Workspace binding or an admission in flight, never an interactive run", async () => {
    const userId = await owner();
    const created = await task(userId, null, { toolsEnabled: true, workspaceEnabled: true });
    const now = new Date();
    const base = (await runner.loadDispatch(now, 10)).workspaceExecuting;
    // An ordinary chat's Workspace run never takes a scheduled slot, and scheduled load never refuses it.
    const interactiveChat = await personalChat(userId);
    const interactive = await runs.createRun(await runInput(userId, interactiveChat.id));
    await bindWorkspace(interactive.runId, interactiveChat.id);
    expect((await runner.loadDispatch(now, 10)).workspaceExecuting).toBe(base);
    // An admission in flight for a Workspace task holds a slot by its lease.
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: now, taskId: created.id,
      trigger: "manual", userId } });
    expect(await runner.acquireLease(occurrence.id, now, new Date(now.getTime() + 60_000))).toBe(true);
    expect((await runner.loadDispatch(now, 10)).workspaceExecuting).toBe(base + 1);
    // Its accepted run with a Workspace binding holds the slot until it is terminal.
    const chat = await personalChat(userId);
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence.id, created)));
    await bindWorkspace(run.runId, chat.id);
    expect((await runner.loadDispatch(now, 10)).workspaceExecuting).toBe(base + 1);
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: run.runId, userId });
    expect((await runner.loadDispatch(now, 10)).workspaceExecuting).toBe(base);
  });

  it("shows a wait for a Workspace slot, ends it at the next attempt and skips one still waiting without counting a failure", async () => {
    const userId = await owner();
    const created = await task(userId, new Date(Date.now() + 3_600_000), { consecutiveFailures: 2, toolsEnabled: true,
      workspaceEnabled: true });
    const now = new Date();
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(now.getTime() - 60_000),
      taskId: created.id, trigger: "schedule", userId } });
    const candidate = async () => (await runner.loadDispatch(now, 500)).pending.find((row) => row.id === occurrence.id);
    expect(await candidate()).toEqual({ id: occurrence.id, recurring: true, scheduledFor: occurrence.scheduledFor, taskId: created.id,
      trigger: "schedule", userId, waiting: false, workspace: true });

    await runner.waitForWorkspace(occurrence.id, now);
    await runner.waitForWorkspace(occurrence.id, new Date(now.getTime() + 30_000));
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).toMatchObject({
      leaseExpiresAt: null, reasonCode: "waiting_for_workspace", startedAt: null, state: "PENDING", workspaceWaitStartedAt: now });
    expect(await candidate()).toMatchObject({ waiting: true });
    expect(await owners.get(userId, created.id)).toMatchObject({ running: true, waitingForWorkspace: true });

    // The next attempt ends the wait and keeps when it began.
    const attempt = new Date(now.getTime() + 60_000);
    expect(await runner.acquireLease(occurrence.id, attempt, new Date(attempt.getTime() + 60_000))).toBe(true);
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).toMatchObject({
      reasonCode: null, startedAt: attempt, workspaceWaitStartedAt: now });
    expect(await owners.get(userId, created.id)).not.toHaveProperty("waitingForWorkspace");
    // A capacity refusal of that attempt waits again and releases the lease.
    await runner.waitForWorkspace(occurrence.id, attempt);
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } })).toMatchObject({
      leaseExpiresAt: null, reasonCode: "waiting_for_workspace", workspaceWaitStartedAt: now });

    // Still waiting when the retry window after its attempt ends: skipped, the task neither failed nor paused.
    const settled = await runner.expirePending(new Date(attempt.getTime() + 31 * 60_000), 500);
    expect(settled.find((row) => row.occurrenceId === occurrence.id)).toMatchObject({
      reasonCode: "workspace_capacity", state: "SKIPPED", taskPaused: false });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } }))
      .toMatchObject({ consecutiveFailures: 2, pauseReason: null, status: "ACTIVE" });

    // Never attempted, a waiting occurrence lasts until its lateness ends, then skips the same way.
    const late = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(now.getTime() - 13 * 3_600_000),
      taskId: created.id, trigger: "schedule", userId } });
    await runner.waitForWorkspace(late.id, new Date(now.getTime() - 13 * 3_600_000));
    expect((await runner.expirePending(now, 500)).find((row) => row.occurrenceId === late.id))
      .toMatchObject({ reasonCode: "workspace_capacity", state: "SKIPPED" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } }))
      .toMatchObject({ consecutiveFailures: 2, status: "ACTIVE" });
  });

  it("skips a waiting occurrence that the next due instant supersedes as a capacity skip", async () => {
    const userId = await owner();
    // A real hourly instant and a fixed claim time: the wall clock crossing an hour must not add a newer instant.
    const due = new Date(Math.floor((Date.now() - 60_000) / 3_600_000) * 3_600_000);
    const created = await task(userId, due, { ...scheduledTaskScheduleColumns(hourly), toolsEnabled: true, workspaceEnabled: true });
    const waiting = await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: new Date(due.getTime() - 3_600_000),
      taskId: created.id, trigger: "schedule", userId } });
    await runner.waitForWorkspace(waiting.id, new Date(due.getTime() - 3_600_000));
    const claim = await runner.claimDue(new Date(due.getTime() + 60_000), 500);
    expect(claim.settlements.find((row) => row.occurrenceId === waiting.id))
      .toMatchObject({ reasonCode: "workspace_capacity", state: "SKIPPED", taskPaused: false });
    expect(await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: created.id, state: "PENDING" } }))
      .toMatchObject([{ reasonCode: null, scheduledFor: due }]);
  });
});
