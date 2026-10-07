// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memoryClient";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaPermanentChatDeletionRepository } from "../chats/permanentDeletion/repository";
import { createPermanentChatDeletionService } from "../chats/permanentDeletion/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "../memory/persistence/authorizations";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import {
  ScheduledOccurrenceConflictError,
  type CreateRunInput,
  type ScheduledOccurrenceAdmission,
  type ScheduledResultCopy
} from "../runs/runRepositoryContract";
import { scheduledPromptUrlDigests } from "./promptUrls";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { createPrismaScheduledTaskStore, scheduledTaskScheduleColumns } from "./store";

const users: string[] = [];
const runner = createPrismaScheduledTaskRunnerStore(prisma);
const runs = createPrismaRunRepository(prisma);
const deletion = createPermanentChatDeletionService({
  authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma), capability: { enabled: true },
  kick: () => undefined, repository: createPrismaPermanentChatDeletionRepository(prisma)
});
let instants = 0;

async function owner(): Promise<string> {
  const id = `scheduled-rotation-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic scheduled rotation", email: `${id}@example.test`, id, status: "active" } });
  await prisma.userSettings.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled", userId: id } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId: id } });
  users.push(id);
  return id;
}

async function occurrence(userId: string, taskId: string) {
  return prisma.scheduledTaskOccurrence.create({ data: {
    scheduledFor: new Date(Date.now() + (instants += 1)), startedAt: new Date(), taskId, trigger: "manual", userId
  } });
}

/** The origin the runner passes, read before preparation like the runner reads it. */
async function origin(occurrenceId: string, taskId: string, overrides: Partial<ScheduledOccurrenceAdmission> = {}):
  Promise<ScheduledOccurrenceAdmission> {
  const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } });
  return { occurrenceId, previousResult: null, relevantMcpServerIds: null, taskChatEpoch: current.chatEpoch,
    taskGeneration: current.generation, taskId, taskRevision: current.revision, ...overrides };
}

/** A scheduled send into `chatId`; with `create`, the first send that creates that chat. */
async function runInput(userId: string, chatId: string, scheduledOccurrence: ScheduledOccurrenceAdmission, create = false):
  Promise<CreateRunInput> {
  const content = textMessageContent("Synthetic scheduled prompt");
  const leaf = create ? null
    : (await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chatId } })).activeLeafMessageId;
  return {
    chatId, content, expectedActiveLeafId: leaf, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
    providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId }),
    normalizedRequest: { attachmentIds: [], chatId, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "none" },
    ...(create ? { personalChat: { defaultProviderModelId: providerTemplateIds.fakeModel, folderId: null, memoryMode: "EXCLUDED" as const } }
      : {}),
    scheduledOccurrence,
    userId
  };
}

const november = { chatPeriod: "2026-11", newChat: { title: "Synthetic brief · November 2026" } } as const;

/** October: a same-chat task's first chat, created by its first run, whose shown result is the baseline. */
async function october(userId: string) {
  const created = await prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatMode: "SAME", emailNotify: false,
    historyRetentionDays: 90, modelId: providerTemplateIds.fakeModel, nextRunAt: null, prompt: "Synthetic scheduled prompt",
    provider: providerTemplateIds.fakeConnection, searchEnabled: false, status: "PAUSED", timeZone: "Europe/Moscow",
    title: "Synthetic brief", userId
  } });
  const chatId = randomUUID();
  const first = await occurrence(userId, created.id);
  const run = await runs.createRun(await runInput(userId, chatId, await origin(first.id, created.id, {
    chatPeriod: "2026-10", newChat: { title: "Synthetic brief · October 2026" } }), true));
  await prisma.modelRun.update({ data: { status: "complete" }, where: { id: run.runId } });
  await runner.settleLinked(first.id, new Date());
  const copy: ScheduledResultCopy = { answer: "October digest", reliedServerIds: [], sourceAssistantMessageId: run.assistantMessageId,
    sourceChatId: chatId };
  return { chatId, copy, run, taskId: created.id };
}

/** Admits the month's first run in a new chat, carrying `copy`; returns the new chat and run. */
async function rotate(userId: string, taskId: string, fromChatId: string, copy: ScheduledResultCopy | null, seedId: string | null = null) {
  const pending = await occurrence(userId, taskId);
  const chatId = randomUUID();
  const run = await runs.createRun(await runInput(userId, chatId, await origin(pending.id, taskId, {
    ...november, ...(copy ? { previousResultCopy: copy } : {}), rotation: { fromChatId, seedId } }), true));
  return { chatId, occurrenceId: pending.id, run };
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chatContinuationWorkspaceSeed.deleteMany({ where: { OR: [{ sourceChat: { userId: { in: ids } } },
    { newChat: { userId: { in: ids } } }] } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted scheduled task chat rotation", () => {
  it("creates a task's chat with its title and origin and records the month it takes", async () => {
    const userId = await owner();
    const { chatId, run, taskId } = await october(userId);
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chatId } }))
      .toMatchObject({ ownerKeptAt: null, scheduledTaskId: taskId, title: "Synthetic brief · October 2026", titleRevision: 0 });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      baselineAssistantMessageId: run.assistantMessageId, baselineRunId: run.runId, chatEpoch: 1, chatId, chatPeriod: "2026-10"
    });
  });

  it("moves the task to the month's new chat with a frozen copy of its previous result, all or nothing", async () => {
    const userId = await owner();
    const { chatId: octoberChat, copy: carried, run, taskId } = await october(userId);
    const copy = { ...carried, reliedServerIds: ["server-relied"] };
    const rotation = { ...november, previousResultCopy: copy, rotation: { fromChatId: octoberChat, seedId: null } };
    const pending = await occurrence(userId, taskId);
    const refused = randomUUID();
    const refuse = async (overrides: Partial<ScheduledOccurrenceAdmission>) => {
      await expect(runs.createRun(await runInput(userId, refused, await origin(pending.id, taskId, { ...rotation, ...overrides }), true)))
        .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
      expect(await prisma.chat.count({ where: { id: refused } })).toBe(0);
    };
    // A stale epoch, a copy of another answer than the baseline, or a rotation from another chat: nothing is created.
    await refuse({ taskChatEpoch: 0 });
    await refuse({ previousResultCopy: { ...copy, sourceAssistantMessageId: run.userMessageId } });
    await refuse({ rotation: { fromChatId: randomUUID(), seedId: null } });

    const novemberChat = randomUUID();
    const admitted = await runs.createRun(await runInput(userId, novemberChat, await origin(pending.id, taskId, rotation), true));
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: novemberChat } }))
      .toMatchObject({ scheduledTaskId: taskId, title: "Synthetic brief · November 2026" });
    // The old chat's ids never reach the new one: the copy stands in for the baseline.
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      baselineAssistantMessageId: null, baselineRunId: null, chatEpoch: 2, chatId: novemberChat, chatPeriod: "2026-11"
    });
    expect(await prisma.scheduledTaskCarryover.findUniqueOrThrow({ where: { taskId } })).toMatchObject({
      answerText: "October digest", chatEpoch: 2, reliedServerIds: ["server-relied"], sourceAssistantMessageId: run.assistantMessageId,
      sourceChatId: octoberChat, taskGeneration: 1, userId
    });
    expect(await prisma.scheduledTaskOccurrence.findUniqueOrThrow({ where: { id: pending.id } }))
      .toMatchObject({ chatEpoch: 2, chatId: novemberChat, runId: admitted.runId, state: "RUNNING" });
  });

  it("reauthorizes the carried copy at every admission and retires it with the new chat's own result", async () => {
    const userId = await owner();
    const { chatId: octoberChat, copy, taskId } = await october(userId);
    const first = await rotate(userId, taskId, octoberChat, copy);
    await prisma.modelRun.update({ data: { errorPayload: { code: "provider_error", message: "x" }, status: "error" },
      where: { id: first.run.runId } });
    await runner.settleLinked(first.occurrenceId, new Date());

    // The month's first run failed: the next one still sees the copy, rechecked against its source.
    const second = await occurrence(userId, taskId);
    expect(await runner.loadExecution(second.id)).toMatchObject({ carriedResult: copy, chat: { id: first.chatId },
      task: { baseline: null, chatEpoch: 2, chatPeriod: "2026-11" } });
    const next = await runs.createRun(await runInput(userId, first.chatId, await origin(second.id, taskId, {
      chatPeriod: "2026-11", previousResultCopy: copy })));
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: next.runId } });
    await runner.settleLinked(second.id, new Date());
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } }))
      .toMatchObject({ baselineRunId: next.runId, chatEpoch: 2, chatId: first.chatId });
    expect(await prisma.scheduledTaskCarryover.count({ where: { taskId } })).toBe(0);

    // A copy that is no longer the task's is refused at the link.
    const third = await occurrence(userId, taskId);
    expect(await runner.loadExecution(third.id)).toMatchObject({ carriedResult: null });
    await expect(runs.createRun(await runInput(userId, first.chatId, await origin(third.id, taskId, { previousResultCopy: copy }))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
  });

  it("moves a still-carried copy on to the next month when the chat it leaves never showed a result", async () => {
    const userId = await owner();
    const { chatId: octoberChat, copy, run, taskId } = await october(userId);
    const november = await rotate(userId, taskId, octoberChat, copy);
    // November never shows a result of its own (its run fails; monitoring checks without news do the same).
    await prisma.modelRun.update({ data: { errorPayload: { code: "provider_error", message: "x" }, status: "error" },
      where: { id: november.run.runId } });
    await runner.settleLinked(november.occurrenceId, new Date());
    const pending = await occurrence(userId, taskId);
    expect(await runner.loadExecution(pending.id)).toMatchObject({ carriedResult: copy, task: { baseline: null, chatEpoch: 2 } });
    const december = { chatPeriod: "2026-12", newChat: { title: "Synthetic brief · December 2026" },
      rotation: { fromChatId: november.chatId, seedId: null } };

    // A copy of anything but the stored one is refused, and nothing is created.
    const refused = randomUUID();
    await expect(runs.createRun(await runInput(userId, refused, await origin(pending.id, taskId, { ...december,
      previousResultCopy: { ...copy, sourceAssistantMessageId: run.userMessageId } }), true)))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    expect(await prisma.chat.count({ where: { id: refused } })).toBe(0);
    // The stored copy itself moves on to December's epoch, its text as frozen.
    const decemberChat = randomUUID();
    await runs.createRun(await runInput(userId, decemberChat, await origin(pending.id, taskId, { ...december,
      previousResultCopy: { ...copy, answer: "Rewritten digest" } }), true));
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } }))
      .toMatchObject({ baselineRunId: null, chatEpoch: 3, chatId: decemberChat, chatPeriod: "2026-12" });
    expect(await prisma.scheduledTaskCarryover.findUniqueOrThrow({ where: { taskId } })).toMatchObject({
      answerText: "October digest", chatEpoch: 3, sourceAssistantMessageId: run.assistantMessageId, sourceChatId: octoberChat
    });
  });

  it("drops a carried copy of another question once the owner changes the prompt", async () => {
    const userId = await owner();
    const { chatId: octoberChat, copy, taskId } = await october(userId);
    const first = await rotate(userId, taskId, octoberChat, copy);
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: first.run.runId, userId });
    await runner.settleLinked(first.occurrenceId, new Date());
    const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } });
    await createPrismaScheduledTaskStore(prisma).update(userId, taskId, { draft: {
      title: "Synthetic brief", prompt: "Another synthetic question", schedule: { kind: "daily", time: "09:00" }, timeZone: "Europe/Moscow",
      modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection, searchEnabled: false, emailNotify: false,
      toolsEnabled: false, workspaceEnabled: false, memoryEnabled: false, pinnedSkillIds: [], chatMode: "same", kind: "standard",
      historyRetentionDays: 90
    }, expectedRevision: current.revision, nextRunAt: null, promptUrls: scheduledPromptUrlDigests("", { kind: "owner" }),
    status: "paused" });
    expect(await prisma.scheduledTaskCarryover.count({ where: { taskId } })).toBe(0);
    const second = await occurrence(userId, taskId);
    expect(await runner.loadExecution(second.id)).toMatchObject({ carriedResult: null, task: { generation: 2 } });
    await expect(runs.createRun(await runInput(userId, first.chatId, await origin(second.id, taskId, { previousResultCopy: copy }))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
  });

  it("stops offering a copy whose source chat is being deleted, and drops it with that chat", async () => {
    const userId = await owner();
    const { chatId: octoberChat, copy, taskId } = await october(userId);
    const first = await rotate(userId, taskId, octoberChat, copy);
    await runs.cancelRun({ payload: { code: "model_run_cancelled", message: "Model run cancelled" }, runId: first.run.runId, userId });
    await runner.settleLinked(first.occurrenceId, new Date());
    const second = await occurrence(userId, taskId);
    expect(await runner.loadExecution(second.id)).toMatchObject({ carriedResult: copy });

    // The owner permanently deletes October's chat: its fence alone ends the copy.
    await deletion.confirm(userId, octoberChat, { alsoForgetOriginMemories: false,
      confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION, requestId: randomUUID() });
    expect(await runner.loadExecution(second.id)).toMatchObject({ carriedResult: null });
    await expect(runs.createRun(await runInput(userId, first.chatId, await origin(second.id, taskId, { previousResultCopy: copy }))))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    // The deletion's cleanup removes the chat, and the copy with it.
    await prisma.chat.delete({ where: { id: octoberChat } });
    expect(await prisma.scheduledTaskCarryover.count({ where: { taskId } })).toBe(0);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ chatId: first.chatId });
  });

  it("keeps a late settlement of a run of the old chat from writing the baseline after the move", async () => {
    const userId = await owner();
    const { chatId: octoberChat, copy, taskId } = await october(userId);
    // A run of the old chat still open when the task moved (the runner never rotates then; forced here).
    const late = await occurrence(userId, taskId);
    const lateRun = await runs.createRun(await runInput(userId, octoberChat, await origin(late.id, taskId, { chatPeriod: "2026-10" })));
    const moved = await rotate(userId, taskId, octoberChat, copy);
    await prisma.modelRun.update({ data: { status: "complete" }, where: { id: lateRun.runId } });
    expect(await runner.settleLinked(late.id, new Date())).toMatchObject({ state: "COMPLETED" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } }))
      .toMatchObject({ baselineRunId: null, chatEpoch: 2, chatId: moved.chatId, chatPeriod: "2026-11" });
    // The carried copy still serves the new chat.
    expect(await prisma.scheduledTaskCarryover.findUniqueOrThrow({ where: { taskId } })).toMatchObject({ chatEpoch: 2 });
  });

  it("transfers the rotation's captured Workspace seed in the same transaction, or nothing", async () => {
    const userId = await owner();
    const { chatId: octoberChat, taskId } = await october(userId);
    const seed = (status: "READY" | "CAPTURING") => prisma.chatContinuationWorkspaceSeed.create({ data: {
      byteSize: 11, checksum: "a".repeat(64), scheduledTaskId: taskId, sourceChatId: octoberChat, status,
      storageKey: `workspace-continuation/${randomUUID()}.tar.gz`
    } });
    const capturing = await seed("CAPTURING");
    const pending = await occurrence(userId, taskId);
    const refused = randomUUID();
    await expect(runs.createRun(await runInput(userId, refused, await origin(pending.id, taskId, {
      ...november, rotation: { fromChatId: octoberChat, seedId: capturing.id } }), true)))
      .rejects.toBeInstanceOf(ScheduledOccurrenceConflictError);
    expect(await prisma.chat.count({ where: { id: refused } })).toBe(0);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ chatEpoch: 1, chatId: octoberChat });

    const ready = await seed("READY");
    const novemberChat = randomUUID();
    await runs.createRun(await runInput(userId, novemberChat, await origin(pending.id, taskId, {
      ...november, rotation: { fromChatId: octoberChat, seedId: ready.id } }), true));
    expect(await prisma.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id: ready.id } }))
      .toMatchObject({ leaseExpiresAt: null, newChatId: novemberChat, sourceChatId: octoberChat, status: "TRANSFERRED" });
  });

  it("archives the chat a rotation left unless the owner keeps it in view", async () => {
    const userId = await owner();
    const { chatId, taskId } = await october(userId);
    // Still the task's chat: never archived.
    expect(await runner.archiveRotatedChat({ chatId, taskId, userId })).toBe(false);
    await prisma.scheduledTask.update({ data: { chatId: null }, where: { id: taskId } });
    await prisma.chat.update({ data: { pinned: true }, where: { id: chatId } });
    expect(await runner.archiveRotatedChat({ chatId, taskId, userId })).toBe(false);
    const folder = await prisma.folder.create({ data: { name: "Kept", userId } });
    await prisma.chat.update({ data: { folderId: folder.id, pinned: false }, where: { id: chatId } });
    expect(await runner.archiveRotatedChat({ chatId, taskId, userId })).toBe(false);
    await prisma.chat.update({ data: { folderId: null }, where: { id: chatId } });
    const share = await prisma.sharedChatSnapshot.create({ data: { chatId, ownerUserId: userId, slugHash: `rotation-${randomUUID()}`,
      snapshot: {}, title: "Shared" } });
    expect(await runner.archiveRotatedChat({ chatId, taskId, userId })).toBe(false);
    await prisma.sharedChatSnapshot.update({ data: { revokedAt: new Date() }, where: { id: share.id } });
    expect(await runner.archiveRotatedChat({ chatId, taskId, userId })).toBe(true);
    // The rotation's archive is not the owner's: the chat stays under retention.
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({ archived: true, ownerKeptAt: null });
    expect(await runner.archiveRotatedChat({ chatId, taskId, userId })).toBe(false);
  });
});
