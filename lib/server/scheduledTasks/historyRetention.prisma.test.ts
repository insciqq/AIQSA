// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { createPrismaPermanentChatDeletionRepository } from "../chats/permanentDeletion/repository";
import { createPermanentChatDeletionService, type PermanentChatDeletionService } from "../chats/permanentDeletion/service";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { createPrismaMemoryMutationAuthorizationRepository } from "../memory/persistence/authorizations";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createPrismaScheduledTaskHistoryRetention, loadScheduledTaskHistoryNextDeletions } from "./historyRetention";
import { createPrismaScheduledTaskRunnerStore } from "./runnerStore";
import { scheduledTaskScheduleColumns } from "./store";

const DAY_MS = 86_400_000;
const users: string[] = [];
const runs = createPrismaRunRepository(prisma);
const runner = createPrismaScheduledTaskRunnerStore(prisma);
const chats = createPrismaChatRepository(prisma);
const service = createPermanentChatDeletionService({
  authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma), capability: { enabled: true },
  kick: () => undefined, repository: createPrismaPermanentChatDeletionRepository(prisma)
});
const retention = createPrismaScheduledTaskHistoryRetention({ deletion: { capability: { enabled: true }, service }, prisma });
let instants = 0;

async function owner(): Promise<string> {
  const id = `scheduled-history-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic scheduled history", email: `${id}@example.test`, id, status: "active" } });
  await prisma.userSettings.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel,
    defaultSearchStrategyId: "search-disabled", userId: id } });
  await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId: id } });
  users.push(id);
  return id;
}

async function task(userId: string, historyRetentionDays: number | null) {
  return prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), chatMode: "NEW", emailNotify: false, historyRetentionDays,
    modelId: providerTemplateIds.fakeModel, nextRunAt: null, prompt: "Synthetic scheduled prompt",
    provider: providerTemplateIds.fakeConnection, searchEnabled: false, status: "PAUSED", timeZone: "Europe/Moscow",
    title: "Synthetic brief", userId
  } });
}

/**
 * A chat the task's run created, as a new-chat task's runs create theirs
 * (it becomes the task's current chat), whose run settled `daysAgo` days ago.
 */
async function taskChat(userId: string, taskId: string, daysAgo: number, now: Date): Promise<string> {
  const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } });
  const pending = await prisma.scheduledTaskOccurrence.create({ data: {
    scheduledFor: new Date(now.getTime() + (instants += 1)), startedAt: now, taskId, trigger: "schedule", userId
  } });
  const chatId = randomUUID();
  const content = textMessageContent("Synthetic scheduled prompt");
  const run = await runs.createRun({
    chatId, content, expectedActiveLeafId: null, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
    providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
      providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId }),
    normalizedRequest: { attachmentIds: [], chatId, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
      modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
      searchPlan: { mode: "all_selected", options: [] }, toolMode: "none" },
    personalChat: { defaultProviderModelId: providerTemplateIds.fakeModel, folderId: null, memoryMode: "EXCLUDED" },
    scheduledOccurrence: { chatPeriod: "2026-10", newChat: { title: "Synthetic brief · October 2026" }, occurrenceId: pending.id,
      previousResult: null, relevantMcpServerIds: null, taskChatEpoch: current.chatEpoch, taskGeneration: current.generation, taskId,
      taskRevision: current.revision },
    userId
  });
  await prisma.modelRun.update({ data: { status: "complete", updatedAt: new Date(now.getTime() - daysAgo * DAY_MS) },
    where: { id: run.runId } });
  return chatId;
}

async function fenced(chatId: string): Promise<boolean> {
  return (await prisma.chat.findUniqueOrThrow({ select: { permanentDeletionAt: true }, where: { id: chatId } })).permanentDeletionAt !== null;
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted scheduled task history retention", () => {
  it("deletes only old untouched task chats, through the owner's permanent deletion, and counts them", async () => {
    const now = new Date();
    const userId = await owner();
    const created = await task(userId, 30);
    const due = await taskChat(userId, created.id, 40, now);
    const archivedDue = await taskChat(userId, created.id, 45, now);
    const recent = await taskChat(userId, created.id, 10, now);
    const written = await taskChat(userId, created.id, 40, now);
    const pinned = await taskChat(userId, created.id, 40, now);
    const filed = await taskChat(userId, created.id, 40, now);
    const shared = await taskChat(userId, created.id, 40, now);
    const renamed = await taskChat(userId, created.id, 40, now);
    const restored = await taskChat(userId, created.id, 40, now);
    const current = await taskChat(userId, created.id, 40, now);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ chatId: current });

    // A rotation archived one chat; the owner touched the others.
    expect(await runner.archiveRotatedChat({ chatId: archivedDue, taskId: created.id, userId })).toBe(true);
    await prisma.message.create({ data: { chatId: written, content: textMessageContent("My own follow-up"), role: "user" } });
    await chats.updateChat({ chatId: pinned, pinned: true, userId });
    const folder = await prisma.folder.create({ data: { name: "Kept", userId } });
    await chats.updateChat({ chatId: filed, folderId: folder.id, userId });
    await prisma.sharedChatSnapshot.create({ data: { chatId: shared, ownerUserId: userId, slugHash: `history-${randomUUID()}`,
      snapshot: {}, title: "Shared" } });
    await chats.updateChat({ chatId: renamed, title: "My October digest", userId });
    expect(await runner.archiveRotatedChat({ chatId: restored, taskId: created.id, userId })).toBe(true);
    const archived = await prisma.chat.findUniqueOrThrow({ where: { id: restored } });
    await chats.setArchived({ archived: false, chatId: restored, expectedChatRevision: archived.memorySourceRevision, userId });
    expect(await prisma.chat.findMany({ select: { id: true }, where: { id: { in: [renamed, restored] }, ownerKeptAt: { not: null } } }))
      .toHaveLength(2);

    // Due first: the oldest untouched chat goes first.
    const before = await loadScheduledTaskHistoryNextDeletions(prisma, userId, [created.id], now);
    expect(before.get(created.id)?.getTime()).toBe(now.getTime() - 45 * DAY_MS + 30 * DAY_MS);

    expect(await retention(now)).toBe(2);
    expect(await fenced(due)).toBe(true);
    expect(await fenced(archivedDue)).toBe(true);
    for (const kept of [recent, written, pinned, filed, shared, renamed, restored, current]) expect(await fenced(kept)).toBe(false);
    // The same durable obligation as the owner's own permanent deletion.
    const purges = await prisma.memoryDeletionOutbox.findMany({ select: { targetId: true },
      where: { operation: "SOURCE_PURGE", userId } });
    expect(purges.map((purge) => purge.targetId).sort()).toEqual([due, archivedDue].sort());
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ historyDeletedChats: 2 });
    // Next: the recent chat, once it is old enough.
    const after = await loadScheduledTaskHistoryNextDeletions(prisma, userId, [created.id], now);
    expect(after.get(created.id)?.getTime()).toBe(now.getTime() - 10 * DAY_MS + 30 * DAY_MS);
    expect(await retention(now)).toBe(0);
  });

  it("never deletes a chat of a task kept forever, a chat without a task or one whose task is gone", async () => {
    const now = new Date();
    const userId = await owner();
    const legacy = await task(userId, null);
    const forever = await taskChat(userId, legacy.id, 400, now);
    await taskChat(userId, legacy.id, 400, now);
    const ordinary = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Synthetic chat", userId } });
    const deleted = await task(userId, 30);
    const orphan = await taskChat(userId, deleted.id, 400, now);
    await taskChat(userId, deleted.id, 400, now);
    await prisma.scheduledTask.delete({ where: { id: deleted.id } });
    // Deleting the task leaves its chats as the owner's ordinary chats.
    expect(await prisma.chat.findUniqueOrThrow({ where: { id: orphan } })).toMatchObject({ scheduledTaskId: null, userId });

    expect(await loadScheduledTaskHistoryNextDeletions(prisma, userId, [legacy.id], now)).toEqual(new Map());
    expect(await retention(now)).toBe(0);
    for (const kept of [forever, ordinary.id, orphan]) expect(await fenced(kept)).toBe(false);
  });

  it("keeps a chat the owner touched after the sweep chose it, and waits while deletion is closed", async () => {
    const now = new Date();
    const userId = await owner();
    const created = await task(userId, 30);
    const raced = await taskChat(userId, created.id, 40, now);
    await taskChat(userId, created.id, 1, now);
    // The owner pins the chat between the sweep's selection and its deletion admission.
    const racing: Pick<PermanentChatDeletionService, "confirm"> = {
      async confirm(...args) {
        await chats.updateChat({ chatId: args[1], pinned: true, userId });
        return service.confirm(...args);
      }
    };
    const sweep = createPrismaScheduledTaskHistoryRetention({ deletion: { capability: { enabled: true }, service: racing }, prisma });
    expect(await sweep(now)).toBe(0);
    expect(await fenced(raced)).toBe(false);
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ historyDeletedChats: 0 });

    await chats.updateChat({ chatId: raced, pinned: false, userId });
    const closed = createPrismaScheduledTaskHistoryRetention({ deletion: { capability: { enabled: false }, service }, prisma });
    expect(await closed(now)).toBe(0);
    expect(await fenced(raced)).toBe(false);
    expect(await retention(now)).toBe(1);
    expect(await fenced(raced)).toBe(true);
  });

  it("keeps a chat a rotation still carries from until the new chat no longer needs it", async () => {
    const now = new Date();
    const userId = await owner();
    const created = await task(userId, 30);
    const source = await taskChat(userId, created.id, 40, now);
    const answer = await prisma.message.findFirstOrThrow({ where: { chatId: source, role: "assistant" } });
    await taskChat(userId, created.id, 1, now);
    const current = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
    await prisma.scheduledTaskCarryover.create({ data: { answerText: "October digest", chatEpoch: current.chatEpoch,
      sourceAssistantMessageId: answer.id, sourceChatId: source, taskGeneration: current.generation, taskId: created.id, userId } });
    const seed = await prisma.chatContinuationWorkspaceSeed.create({ data: { newChatId: current.chatId, scheduledTaskId: created.id,
      sourceChatId: source, status: "TRANSFERRED", storageKey: `workspace-continuation/${randomUUID()}.tar.gz`, checksum: "a".repeat(64),
      byteSize: 11 } });
    expect(await retention(now)).toBe(0);
    await prisma.scheduledTaskCarryover.delete({ where: { taskId: created.id } });
    expect(await retention(now)).toBe(0);
    // Restored into the new chat: the old one may go.
    await prisma.chatContinuationWorkspaceSeed.update({ data: { status: "RESTORED" }, where: { id: seed.id } });
    expect(await retention(now)).toBe(1);
    expect(await fenced(source)).toBe(true);
    await prisma.chatContinuationWorkspaceSeed.delete({ where: { id: seed.id } });
  });
});
