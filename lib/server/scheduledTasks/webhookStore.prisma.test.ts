// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  SCHEDULED_TASK_WEBHOOK_EVENT_RETENTION_MS,
  SCHEDULED_TASK_WEBHOOK_QUEUE_LIMIT,
  SCHEDULED_TASK_WEBHOOK_RATE_LIMIT,
  type ScheduledTaskDraft
} from "../../contracts/scheduledTasks";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { ScheduledOccurrenceConflictError, type CreateRunInput, type ScheduledOccurrenceAdmission } from "../runs/runRepositoryContract";
import { scheduledPromptUrlDigests } from "./promptUrls";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { createPrismaScheduledTaskStore, scheduledTaskScheduleColumns, ScheduledTaskError } from "./store";
import { scheduledWebhookTokenHash } from "./webhookEvent";
import type { ScheduledTaskWebhookEventInput } from "./webhookIntake";
import { createPrismaScheduledTaskWebhookIntakeStore } from "./webhookStore";

const users: string[] = [];
const owners = createPrismaScheduledTaskStore(prisma);
const runner = createPrismaScheduledTaskRunnerStore(prisma);
const runs = createPrismaRunRepository(prisma);
const noUrls = scheduledPromptUrlDigests("", { kind: "owner" });
const HOUR = 3_600_000;
const webhookDraft: ScheduledTaskDraft = {
  title: "Synthetic pipeline digest", prompt: "Summarize the synthetic event", schedule: { kind: "daily", time: "09:00" },
  scheduleEnabled: false, webhookEnabled: true, timeZone: "Europe/Moscow", modelId: providerTemplateIds.fakeModel,
  provider: providerTemplateIds.fakeConnection, searchEnabled: false, emailNotify: false, telegramNotify: false, toolsEnabled: false,
  workspaceEnabled: false, memoryEnabled: false, pinnedSkillIds: [], chatMode: "same", kind: "standard", historyRetentionDays: 90
};

async function owner(): Promise<string> {
  const id = `scheduled-webhook-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic webhook owner", email: `${id}@example.test`, id, status: "active" } });
  await prisma.userSettings.create({ data: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled", userId: id } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId: id } });
  users.push(id);
  return id;
}

/** A webhook-only automation with its first token, and an intake whose clock the test moves. */
async function hooked(userId: string, issuedAt = new Date()) {
  const task = await owners.create(userId, webhookDraft, null, noUrls);
  const issued = await owners.issueWebhookToken(userId, task.id, issuedAt);
  const clock = { now: new Date() };
  const intake = createPrismaScheduledTaskWebhookIntakeStore(prisma, { now: () => clock.now });
  const tokenHash = scheduledWebhookTokenHash(issued.token);
  const accept = (event: Partial<ScheduledTaskWebhookEventInput> = {}, hash = tokenHash) => intake.accept({
    event: { bodyText: "{}", contentType: "application/json", dedupeKey: null, eventName: null, ...event },
    publicId: issued.publicId, taskId: task.id, tokenHash: hash, userId
  });
  return { accept, clock, intake, issued, task, tokenHash };
}

const events = (taskId: string) =>
  prisma.scheduledTaskWebhookEvent.findMany({ orderBy: { receivedAt: "asc" }, where: { taskId } });

/** Bodyless events already handled, at the given instants. */
async function handled(taskId: string, userId: string, instants: readonly Date[]) {
  await prisma.scheduledTaskWebhookEvent.createMany({ data: instants.map((receivedAt) => ({
    receivedAt, state: "ADMITTED" as const, taskId, userId
  })) });
}

/** The scheduled origin the runner passes for an occurrence of `task`, as read before preparation. */
function origin(occurrenceId: string, task: Readonly<{ chatEpoch: number; generation: number; id: string; revision: number }>,
  text: string): ScheduledOccurrenceAdmission {
  return { occurrenceId, previousResult: null, relevantMcpServerIds: null, taskChatEpoch: task.chatEpoch,
    taskGeneration: task.generation, taskId: task.id, taskRevision: task.revision, webhookEvent: { text } };
}

/** A send into an existing chat, as the send handler hands it to run creation. */
async function runInput(userId: string, chatId: string, scheduledOccurrence: ScheduledOccurrenceAdmission): Promise<CreateRunInput> {
  const content = { blocks: [{ text: webhookDraft.prompt, type: "text" }, { text: scheduledOccurrence.webhookEvent!.text, type: "text" }] };
  const leaf = await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chatId } });
  return {
    chatId, content, expectedActiveLeafId: leaf.activeLeafMessageId, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
    defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
      searchPlan: { mode: "all_selected", optionIds: [] }, userId },
    providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId }),
    normalizedRequest: { attachmentIds: [], chatId, content, modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: false, vision: false }, modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "none" },
    scheduledOccurrence, userId
  };
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("automation webhook intake", () => {
  it("queues concurrent events in arrival order, one millisecond apart, and records the last one", async () => {
    const userId = await owner();
    const { accept, clock, intake, issued, task, tokenHash } = await hooked(userId);
    expect(await intake.find(issued.publicId)).toEqual({ open: true, taskId: task.id, tokenHash, userId });
    expect(await intake.find("AbCdEfGhIjKlMnOpQrSt_-")).toBeNull();
    const at = new Date("2026-10-25T10:00:00.000Z");
    clock.now = at;
    expect(await Promise.all([accept({ bodyText: "first" }), accept({ bodyText: "second" })]))
      .toEqual([{ kind: "accepted" }, { kind: "accepted" }]);
    // A clock behind the last event still orders after it.
    clock.now = new Date(at.getTime() - 60_000);
    expect(await accept({ bodyText: "third", eventName: "Pipeline Hook" })).toEqual({ kind: "accepted" });
    const queued = await events(task.id);
    expect(queued.map((event) => [event.receivedAt.getTime() - at.getTime(), event.state])).toEqual([[0, "QUEUED"], [1, "QUEUED"],
      [2, "QUEUED"]]);
    expect(new Set(queued.slice(0, 2).map((event) => event.bodyText))).toEqual(new Set(["first", "second"]));
    expect(queued[2]).toMatchObject({ bodyText: "third", contentType: "application/json", eventName: "Pipeline Hook", userId });
    expect((await prisma.scheduledTaskWebhook.findUniqueOrThrow({ where: { taskId: task.id } })).lastEventAt)
      .toEqual(new Date(at.getTime() + 2));
    expect(await owners.get(userId, task.id)).toMatchObject({ webhook: { queuedEvents: 3 } });
  });

  it("accepts a delivery key once while its event is kept, per automation", async () => {
    const userId = await owner();
    const first = await hooked(userId);
    const second = await hooked(userId);
    expect(await first.accept({ dedupeKey: "delivery-1" })).toEqual({ kind: "accepted" });
    expect(await Promise.all([first.accept({ dedupeKey: "delivery-1" }), first.accept({ dedupeKey: "delivery-1" })]))
      .toEqual([{ kind: "duplicate" }, { kind: "duplicate" }]);
    // Still a repeat once the event ran and its body is gone.
    await prisma.scheduledTaskWebhookEvent.updateMany({ data: { bodyText: null, state: "ADMITTED" }, where: { taskId: first.task.id } });
    expect(await first.accept({ dedupeKey: "delivery-1" })).toEqual({ kind: "duplicate" });
    expect(await second.accept({ dedupeKey: "delivery-1" })).toEqual({ kind: "accepted" });
    expect(await prisma.scheduledTaskWebhookEvent.count({ where: { dedupeKey: "delivery-1", userId } })).toBe(2);
  });

  it("caps the waiting queue and the events of the rate window", async () => {
    const userId = await owner();
    const queue = await hooked(userId);
    const now = new Date();
    queue.clock.now = now;
    await prisma.scheduledTaskWebhookEvent.createMany({ data: Array.from({ length: SCHEDULED_TASK_WEBHOOK_QUEUE_LIMIT }, (_value, index) => ({
      bodyText: "{}", receivedAt: new Date(now.getTime() - HOUR * 2 - index), taskId: queue.task.id, userId
    })) });
    expect(await queue.accept()).toEqual({ kind: "queue_full" });
    await prisma.scheduledTaskWebhookEvent.updateMany({ data: { bodyText: null, state: "DISCARDED" }, where: { taskId: queue.task.id } });
    expect(await queue.accept()).toEqual({ kind: "accepted" });

    const rate = await hooked(userId);
    rate.clock.now = now;
    // The oldest event of the window leaves it in thirty seconds.
    const oldest = new Date(now.getTime() - HOUR + 30_000);
    await handled(rate.task.id, userId, Array.from({ length: SCHEDULED_TASK_WEBHOOK_RATE_LIMIT }, (_value, index) =>
      new Date(oldest.getTime() + index)));
    expect(await rate.accept()).toEqual({ kind: "rate_limited", retryAfterSeconds: 30 });
    expect(await prisma.scheduledTaskWebhookEvent.count({ where: { taskId: rate.task.id } })).toBe(SCHEDULED_TASK_WEBHOOK_RATE_LIMIT);
    rate.clock.now = new Date(now.getTime() + 31_000);
    expect(await rate.accept()).toEqual({ kind: "accepted" });
  });

  it("refuses under the task lock once the token rotated, the automation stopped or its owner did", async () => {
    const userId = await owner();
    const { accept, intake, issued, task, tokenHash } = await hooked(userId);
    const rotated = await owners.issueWebhookToken(userId, task.id, new Date());
    expect(rotated.publicId).toBe(issued.publicId);
    expect(rotated.token).not.toBe(issued.token);
    expect(await accept()).toEqual({ kind: "refused" });
    const fresh = scheduledWebhookTokenHash(rotated.token);
    expect(await accept({}, fresh)).toEqual({ kind: "accepted" });
    expect((await intake.find(issued.publicId))?.tokenHash).toBe(fresh);
    expect(tokenHash).not.toBe(fresh);

    // The trigger turned off, then the task paused: each closes the webhook.
    const off = await owners.update(userId, task.id, { draft: { ...webhookDraft, scheduleEnabled: true, webhookEnabled: false },
      expectedRevision: 1, nextRunAt: new Date(Date.now() + HOUR), promptUrls: "keep", status: "active" });
    expect(await intake.find(issued.publicId)).toMatchObject({ open: false });
    expect(await accept({}, fresh)).toEqual({ kind: "refused" });
    const on = await owners.update(userId, task.id, { draft: webhookDraft, expectedRevision: off.revision, nextRunAt: null,
      promptUrls: "keep", status: "active" });
    expect(await accept({}, fresh)).toEqual({ kind: "accepted" });
    await owners.update(userId, task.id, { draft: webhookDraft, expectedRevision: on.revision, nextRunAt: null, promptUrls: "keep",
      status: "paused" });
    expect(await intake.find(issued.publicId)).toMatchObject({ open: false });
    expect(await accept({}, fresh)).toEqual({ kind: "refused" });

    const other = await hooked(userId);
    const otherHash = scheduledWebhookTokenHash((await owners.issueWebhookToken(userId, other.task.id, new Date())).token);
    await prisma.user.update({ data: { scimDeactivatedAt: new Date() }, where: { id: userId } });
    expect(await other.intake.find(other.issued.publicId)).toMatchObject({ open: false });
    expect(await other.accept({}, otherHash)).toEqual({ kind: "refused" });
    await prisma.user.update({ data: { scimDeactivatedAt: null, status: "disabled" }, where: { id: userId } });
    expect(await other.accept({}, otherHash)).toEqual({ kind: "refused" });
  });
});

describe("automation webhook token", () => {
  it("stores only the hash of a token it issues to the owner while the trigger is on", async () => {
    const userId = await owner();
    const task = await owners.create(userId, webhookDraft, null, noUrls);
    const issuedAt = new Date("2026-10-25T09:00:00.000Z");
    const issued = await owners.issueWebhookToken(userId, task.id, issuedAt);
    const row = await prisma.scheduledTaskWebhook.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(row).toMatchObject({ publicId: issued.publicId, tokenHash: scheduledWebhookTokenHash(issued.token), tokenIssuedAt: issuedAt });
    expect(JSON.stringify(row)).not.toContain(issued.token.slice("aiqsa_wh_".length));
    expect(JSON.stringify(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } }))).not.toContain(issued.token);
    expect(await owners.get(userId, task.id)).toMatchObject({ webhook: { tokenIssuedAt: issuedAt.toISOString() } });

    // Paused automations get one too; another owner's, or one whose trigger is off, never.
    const paused = await owners.update(userId, task.id, { draft: webhookDraft, expectedRevision: 1, nextRunAt: null, promptUrls: "keep",
      status: "paused" });
    await expect(owners.issueWebhookToken(userId, task.id, new Date())).resolves.toMatchObject({ publicId: issued.publicId });
    const stranger = await owner();
    await expect(owners.issueWebhookToken(stranger, task.id, new Date()))
      .rejects.toSatisfy((error) => error instanceof ScheduledTaskError && error.code === "scheduled_task_not_found");
    await owners.update(userId, task.id, { draft: { ...webhookDraft, scheduleEnabled: true, webhookEnabled: false },
      expectedRevision: paused.revision, nextRunAt: null, promptUrls: "keep", status: "paused" });
    await expect(owners.issueWebhookToken(userId, task.id, new Date()))
      .rejects.toSatisfy((error) => error instanceof ScheduledTaskError && error.code === "scheduled_task_webhook_off");
    // The token stays as it was: turning the trigger on again needs no new one.
    expect((await prisma.scheduledTaskWebhook.findUniqueOrThrow({ where: { taskId: task.id } })).tokenHash).not.toBeNull();
  });
});

describe("automation webhook events in the runner", () => {
  it("turns waiting events into occurrences one at a time, in order, and discards one that ends without a run", async () => {
    const userId = await owner();
    const { accept, clock, task } = await hooked(userId);
    const at = new Date(Date.now() - 60_000);
    clock.now = at;
    await accept({ bodyText: "first" });
    await accept({ bodyText: "second" });
    expect((await runner.claimDue(new Date(), 10)).claimed).toBe(1);
    const [first] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    expect(first).toMatchObject({ scheduledFor: at, state: "PENDING", trigger: "webhook" });
    // The open occurrence holds the next event back, whoever claims.
    expect((await Promise.all([runner.claimDue(new Date(), 10), runner.claimDue(new Date(), 10)])).map((claim) => claim.claimed))
      .toEqual([0, 0]);
    // It carries its event, by its instant, while the event waits.
    const execution = await runner.loadExecution(first!.id);
    expect(execution?.webhookEvent).toEqual({ bodyText: "first", contentType: "application/json", eventName: null, receivedAt: at });
    expect(execution?.occurrence.trigger).toBe("webhook");

    // Ending without a run discards its event: its body goes, and it never runs later.
    expect(await runner.settlePending(first!.id, { reasonCode: "missed", state: "SKIPPED" }, new Date())).toMatchObject({ state: "SKIPPED" });
    expect((await events(task.id)).map((event) => [event.state, event.bodyText])).toEqual([["DISCARDED", null], ["QUEUED", "second"]]);
    expect((await runner.claimDue(new Date(), 10)).claimed).toBe(1);
    expect(await prisma.scheduledTaskOccurrence.findMany({ orderBy: { scheduledFor: "asc" }, where: { taskId: task.id } }))
      .toMatchObject([{ state: "SKIPPED" }, { scheduledFor: new Date(at.getTime() + 1), state: "PENDING", trigger: "webhook" }]);
  });

  it("admits the event with its run: linked, admitted and without a body, or refuses the run", async () => {
    const userId = await owner();
    const { accept, task } = await hooked(userId);
    await accept({ bodyText: "{\"status\":\"failed\"}" });
    await runner.claimDue(new Date(), 10);
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Synthetic pipeline digest", userId } });
    const run = await runs.createRun(await runInput(userId, chat.id, origin(occurrence!.id, current, "Incoming webhook event.")));
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: occurrence!.id } }))
      .toMatchObject({ runId: run.runId, state: "RUNNING" });
    expect(await events(task.id)).toMatchObject([{ bodyText: null, occurrenceId: occurrence!.id, state: "ADMITTED" }]);
    // The run's user turn is the prompt and then the event, in the chat only.
    expect((await prisma.message.findUniqueOrThrow({ where: { id: run.userMessageId } })).content).toEqual({ blocks: [
      { text: webhookDraft.prompt, type: "text" }, { text: "Incoming webhook event.", type: "text" }] });
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: run.runId, userId });
    await runner.settleFinishedRuns(new Date(), 10);

    // An event that no longer waits refuses its run, and nothing is created.
    await accept({ bodyText: "late" });
    await runner.claimDue(new Date(), 10);
    const late = await prisma.scheduledTaskOccurrence.findFirstOrThrow({ where: { state: "PENDING", taskId: task.id } });
    await prisma.scheduledTaskWebhookEvent.updateMany({ data: { bodyText: null, state: "DISCARDED" }, where: { state: "QUEUED", taskId: task.id } });
    const messages = await prisma.message.count({ where: { chatId: chat.id } });
    // The task as the runner reads it now: in the chat its first run moved it to.
    const later = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(later).toMatchObject({ chatEpoch: 1, chatId: chat.id });
    await expect(runs.createRun(await runInput(userId, chat.id, origin(late.id, later, "Incoming webhook event."))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    expect(await prisma.message.count({ where: { chatId: chat.id } })).toBe(messages);
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({ runId: null, state: "PENDING" });
  });

  it("discards waiting events on a pause or a trigger turned off, keeping the one an open occurrence carries", async () => {
    const userId = await owner();
    const { accept, task } = await hooked(userId);
    for (const bodyText of ["a", "b", "c"]) await accept({ bodyText });
    await runner.claimDue(new Date(), 10);
    const paused = await owners.update(userId, task.id, { draft: webhookDraft, expectedRevision: 1, nextRunAt: null, promptUrls: "keep",
      status: "paused" });
    expect((await events(task.id)).map((event) => [event.state, event.bodyText])).toEqual([["QUEUED", "a"], ["DISCARDED", null],
      ["DISCARDED", null]]);
    // The runner skips the open one as paused, which discards its event too.
    const [open] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    await runner.settlePending(open!.id, { reasonCode: "paused", state: "SKIPPED" }, new Date());
    expect((await events(task.id)).map((event) => event.state)).toEqual(["DISCARDED", "DISCARDED", "DISCARDED"]);
    expect(await owners.get(userId, task.id)).toMatchObject({ webhook: { queuedEvents: 0 } });

    // Resumed, then moved to its schedule alone: the event waiting meanwhile never runs either.
    const resumed = await owners.update(userId, task.id, { draft: webhookDraft, expectedRevision: paused.revision, nextRunAt: null,
      promptUrls: "keep", status: "active" });
    await accept({ bodyText: "d" });
    await owners.update(userId, task.id, { draft: { ...webhookDraft, scheduleEnabled: true, webhookEnabled: false },
      expectedRevision: resumed.revision, nextRunAt: new Date(Date.now() + HOUR), promptUrls: "keep", status: "active" });
    expect((await events(task.id)).at(-1)).toMatchObject({ bodyText: null, state: "DISCARDED" });
  });

  it("discards the waiting events of an automation that can no longer take them instead of claiming them", async () => {
    const userId = await owner();
    const stopped = await hooked(userId);
    const now = new Date();
    // Events left waiting by a writer that did not discard them: a task paused and one whose trigger is off.
    await prisma.scheduledTaskWebhookEvent.create({ data: { bodyText: "x", receivedAt: new Date(now.getTime() - 1_000),
      taskId: stopped.task.id, userId } });
    await prisma.scheduledTask.update({ data: { revision: { increment: 1 }, status: "PAUSED" }, where: { id: stopped.task.id } });
    const off = await hooked(userId);
    await prisma.scheduledTaskWebhookEvent.create({ data: { bodyText: "y", receivedAt: new Date(now.getTime() - 1_000),
      taskId: off.task.id, userId } });
    await prisma.scheduledTask.update({ data: { nextRunAt: new Date(now.getTime() + HOUR), scheduleEnabled: true, webhookEnabled: false },
      where: { id: off.task.id } });
    expect((await runner.claimDue(now, 10)).claimed).toBe(0);
    expect(await prisma.scheduledTaskOccurrence.count({ where: { userId } })).toBe(0);
    expect((await prisma.scheduledTaskWebhookEvent.findMany({ where: { userId } })).map((event) => [event.state, event.bodyText]))
      .toEqual([["DISCARDED", null], ["DISCARDED", null]]);
  });

  it("discards the waiting events of a task its settlement pauses", async () => {
    const userId = await owner();
    const { accept, task } = await hooked(userId);
    await accept({ bodyText: "first" });
    await accept({ bodyText: "second" });
    await runner.claimDue(new Date(), 10);
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(await runner.settlePending(occurrence!.id, { pauseReason: "model_unavailable", reasonCode: "model_unavailable", state: "FAILED" },
      new Date(), current.revision)).toMatchObject({ taskPaused: true });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "PAUSED" });
    expect((await events(task.id)).map((event) => [event.state, event.bodyText])).toEqual([["DISCARDED", null], ["DISCARDED", null]]);
  });

  it("turns a once schedule off at its claim and keeps the automation on its webhook", async () => {
    const userId = await owner();
    const due = new Date(Date.now() - 60_000);
    const both = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "once", date: "2026-10-25", time: "09:00" }), chatMode: "SAME",
      modelId: providerTemplateIds.fakeModel, nextRunAt: due, prompt: webhookDraft.prompt, provider: providerTemplateIds.fakeConnection,
      scheduleEnabled: true, timeZone: "Europe/Moscow", title: "Synthetic once", userId, webhookEnabled: true
    } });
    const only = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "once", date: "2026-10-25", time: "09:00" }), chatMode: "SAME",
      modelId: providerTemplateIds.fakeModel, nextRunAt: due, prompt: webhookDraft.prompt, provider: providerTemplateIds.fakeConnection,
      timeZone: "Europe/Moscow", title: "Synthetic once only", userId
    } });
    expect((await runner.claimDue(new Date(), 10)).claimed).toBe(2);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: both.id } }))
      .toMatchObject({ nextRunAt: null, revision: 2, scheduleEnabled: false, status: "ACTIVE", webhookEnabled: true });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: only.id } }))
      .toMatchObject({ nextRunAt: null, scheduleEnabled: true, status: "COMPLETED" });
    for (const taskId of [both.id, only.id]) {
      expect(await prisma.scheduledTaskOccurrence.findMany({ where: { taskId } }))
        .toMatchObject([{ scheduledFor: due, state: "PENDING", trigger: "schedule" }]);
    }
  });

  it("deletes bodyless events past their retention in bounded batches, never a waiting one", async () => {
    const userId = await owner();
    const { task } = await hooked(userId);
    const now = new Date();
    const expired = new Date(now.getTime() - SCHEDULED_TASK_WEBHOOK_EVENT_RETENTION_MS - 1_000);
    await handled(task.id, userId, [expired, new Date(expired.getTime() + 1), new Date(now.getTime() - HOUR)]);
    await prisma.scheduledTaskWebhookEvent.create({ data: { bodyText: "waiting", receivedAt: new Date(expired.getTime() - 1),
      taskId: task.id, userId } });
    await prisma.scheduledTaskWebhookEvent.create({ data: { receivedAt: new Date(expired.getTime() + 2), state: "DISCARDED",
      taskId: task.id, userId } });
    await runner.claimDue(now, 10);
    expect((await events(task.id)).map((event) => [event.receivedAt, event.state])).toEqual([
      [new Date(expired.getTime() - 1), "QUEUED"], [new Date(now.getTime() - HOUR), "ADMITTED"]
    ]);
  });

  it("leaves with the automation and the account, events linked to occurrences included", async () => {
    const userId = await owner();
    const { accept, task } = await hooked(userId);
    await accept();
    await accept();
    await runner.claimDue(new Date(), 10);
    const [occurrence] = await prisma.scheduledTaskOccurrence.findMany({ where: { taskId: task.id } });
    await prisma.scheduledTaskWebhookEvent.updateMany({ data: { bodyText: null, occurrenceId: occurrence!.id, state: "ADMITTED" },
      where: { receivedAt: occurrence!.scheduledFor, taskId: task.id } });
    // Pruning the occurrence history keeps the bodyless row for deduplication.
    await prisma.scheduledTaskOccurrence.delete({ where: { id: occurrence!.id } });
    expect(await events(task.id)).toMatchObject([{ occurrenceId: null, state: "ADMITTED" }, { state: "QUEUED" }]);
    expect(await owners.delete(userId, task.id)).toBe(true);
    expect(await prisma.scheduledTaskWebhook.count({ where: { taskId: task.id } })).toBe(0);
    expect(await prisma.scheduledTaskWebhookEvent.count({ where: { taskId: task.id } })).toBe(0);
    // Deleting the account takes its automations along, with their webhooks and events.
    const kept = await hooked(userId);
    await kept.accept();
    expect(await prisma.scheduledTaskWebhookEvent.count({ where: { userId } })).toBe(1);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.scheduledTask.count({ where: { userId } })).toBe(0);
    expect(await prisma.scheduledTaskWebhookEvent.count({ where: { userId } })).toBe(0);
    expect(await prisma.scheduledTaskWebhook.count({ where: { userId } })).toBe(0);
  });
});
