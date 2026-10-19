// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { scheduledTaskScheduleColumns } from "../scheduledTasks/store";
import type { StorageAdapter } from "../uploads/storage";
import { TELEGRAM_SCHEDULED_CODES, createPrismaTelegramScheduledDeliveryStore } from "./scheduledDelivery";

/**
 * The Telegram outbox in PostgreSQL: one row per notifying occurrence of a
 * task with Telegram delivery on (`ON CONFLICT DO NOTHING`), the attempt
 * claim and settlements, and what a delivery reads before each attempt.
 */

const NOW = new Date("2026-10-19T08:00:00.000Z");
const users: string[] = [];
const objects = new Map<string, Buffer>();
const storage = { getObject: async (storageKey: string) => {
  const body = objects.get(storageKey);
  if (!body) throw new Error("missing object");
  return { body, contentType: "application/octet-stream", storageKey };
} } as unknown as StorageAdapter;
const store = createPrismaTelegramScheduledDeliveryStore({ prisma, storage: () => storage });

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.attachment.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  objects.clear();
});
afterAll(() => prisma.$disconnect());

async function owner(): Promise<string> {
  const user = await prisma.user.create({ data: { displayName: "Synthetic Telegram delivery", id: `telegram-delivery-${randomUUID()}`,
    status: "active" } });
  users.push(user.id);
  return user.id;
}

async function task(userId: string, telegramNotify = true) {
  return prisma.scheduledTask.create({ data: {
    ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), modelId: "fixture", prompt: "Synthetic prompt", provider: "fake",
    telegramNotify, timeZone: "Europe/Moscow", title: "Synthetic brief", userId
  } });
}

/** A completed run in its own chat with the answer `text`. */
async function completedRun(userId: string, taskId: string, text = "Synthetic **result**") {
  const chat = await prisma.chat.create({ data: { title: "Synthetic brief", userId } });
  const question = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Synthetic prompt"), role: "user" } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(text), parentMessageId: question.id,
    role: "assistant" } });
  const run = await prisma.modelRun.create({ data: {
    assistantMessageId: answer.id, chatId: chat.id, modelId: "fixture", normalizedRequest: {}, provider: "fake", status: "complete",
    userId, userMessageId: question.id
  } });
  const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
    chatId: chat.id, finishedAt: NOW, runId: run.id, scheduledFor: NOW, startedAt: NOW, state: "COMPLETED", taskId, trigger: "manual", userId
  } });
  return { answer, chat, occurrence, run };
}

async function row(occurrenceId: string) {
  return prisma.telegramScheduledDelivery.findUniqueOrThrow({ where: { occurrenceId } });
}

async function due(occurrenceId: string) {
  return (await store.listDue(new Date(NOW.getTime() + 1), 500)).find((entry) => entry.occurrenceId === occurrenceId)!;
}

describe("Telegram scheduled delivery outbox", () => {
  it("records one row per settled occurrence of a task with Telegram delivery on, and nothing else", async () => {
    const userId = await owner();
    const on = await task(userId);
    const { occurrence } = await completedRun(userId, on.id);
    expect(await store.enqueue(occurrence.id, NOW)).toBe(true);
    // A second notification of the same occurrence changes nothing (`ON CONFLICT DO NOTHING`).
    expect(await store.enqueue(occurrence.id, new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(await prisma.telegramScheduledDelivery.findMany({ where: { userId } })).toEqual([expect.objectContaining({
      attempts: 0, createdAt: NOW, lastFailureCode: null, nextAttemptAt: NOW, occurrenceId: occurrence.id, sentAt: null, state: "pending"
    })]);

    const off = await task(userId, false);
    const quiet = await completedRun(userId, off.id);
    expect(await store.enqueue(quiet.occurrence.id, NOW)).toBe(false);
    const running = await prisma.scheduledTaskOccurrence.create({ data: {
      scheduledFor: new Date(NOW.getTime() + 3_600_000), state: "RUNNING", taskId: on.id, trigger: "manual", userId
    } });
    expect(await store.enqueue(running.id, NOW)).toBe(false);
    expect(await store.enqueue(randomUUID(), NOW)).toBe(false);
    expect(await prisma.telegramScheduledDelivery.count({ where: { userId } })).toBe(1);
  });

  it("claims an attempt once, releases it for later and settles it once", async () => {
    const userId = await owner();
    const { occurrence } = await completedRun(userId, (await task(userId)).id);
    await store.enqueue(occurrence.id, NOW);
    const pending = await due(occurrence.id);
    const lease = new Date(NOW.getTime() + 15 * 60_000);
    const [first, second] = await Promise.all([0, 1].map(() => store.claim({ attempts: 0, id: pending.id, leaseUntil: lease })));
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await row(occurrence.id)).toMatchObject({ attempts: 1, lastFailureCode: TELEGRAM_SCHEDULED_CODES.unknown, nextAttemptAt: lease });
    // Claimed rows are not due until their lease ends.
    expect(await due(occurrence.id)).toBeUndefined();
    const retryAt = new Date(NOW.getTime() - 1);
    await store.release({ code: "telegram_rate_limited", id: pending.id, nextAttemptAt: retryAt });
    expect(await due(occurrence.id)).toMatchObject({ attempts: 1, lastFailureCode: "telegram_rate_limited" });
    expect(await store.settle({ at: NOW, code: null, id: pending.id, state: "sent" })).toBe(true);
    expect(await store.settle({ at: NOW, code: "telegram_delivery_unknown", id: pending.id, state: "unknown" })).toBe(false);
    expect(await row(occurrence.id)).toMatchObject({ lastFailureCode: null, sentAt: NOW, state: "sent" });
    expect(await store.claim({ attempts: 1, id: pending.id, leaseUntil: lease })).toBe(false);
  });

  it("reads a completed result from its run's chat with the task's switch and title", async () => {
    const userId = await owner();
    const brief = await task(userId);
    const { answer, chat, occurrence } = await completedRun(userId, brief.id, "Synthetic **result**");
    await store.enqueue(occurrence.id, NOW);
    const context = await store.load(await due(occurrence.id));
    expect(context).toMatchObject({
      chat: { id: chat.id, usable: true },
      occurrence: { reasonCode: null, state: "COMPLETED", trigger: "manual", unavailableSources: [] },
      result: { markdown: "Synthetic **result**", messageId: answer.id },
      task: { pauseReason: null, telegramNotify: true, title: "Synthetic brief" }
    });

    // The switch turned off and the chat waiting for deletion are read as they are now.
    await prisma.scheduledTask.update({ data: { telegramNotify: false }, where: { id: brief.id } });
    // The deletion fence needs its exact durable purge operation (database guard).
    const revision = await prisma.chat.findUniqueOrThrow({ select: { memorySourceRevision: true }, where: { id: chat.id } });
    const deletion = await prisma.memoryDeletionOutbox.create({ data: {
      admissionAuthorizationId: randomUUID(), admittedChatSourceRevision: revision.memorySourceRevision, alsoForgetOriginMemories: false,
      memoryGeneration: 0, operation: "SOURCE_PURGE", targetId: chat.id, targetType: "CHAT@memory-chat-delete-v1", userId
    } });
    await prisma.chat.update({
      data: { archived: true, memoryMode: "EXCLUDED", permanentDeletionAt: NOW, permanentDeletionOperationId: deletion.id }, where: { id: chat.id }
    });
    const later = await store.load(await due(occurrence.id));
    expect(later?.task.telegramNotify).toBe(false);
    expect(later?.chat?.usable).toBe(false);
  });

  it("reads a deleted result chat as unavailable and a failure's chat from the task", async () => {
    const userId = await owner();
    const brief = await task(userId);
    const { chat, occurrence } = await completedRun(userId, brief.id);
    await store.enqueue(occurrence.id, NOW);
    await prisma.chat.delete({ where: { id: chat.id } });
    expect(await store.load(await due(occurrence.id))).toMatchObject({ chat: null, result: null });

    const current = await prisma.chat.create({ data: { title: "Synthetic brief", userId } });
    await prisma.scheduledTask.update({ data: { chatId: current.id, pauseReason: "model_unavailable", status: "PAUSED" },
      where: { id: brief.id } });
    const failed = await prisma.scheduledTaskOccurrence.create({ data: {
      finishedAt: NOW, reasonCode: "model_unavailable", scheduledFor: new Date(NOW.getTime() + 60_000), state: "FAILED", taskId: brief.id,
      trigger: "schedule", userId
    } });
    await store.enqueue(failed.id, NOW);
    expect(await store.load(await due(failed.id))).toMatchObject({
      chat: { id: current.id, usable: true },
      occurrence: { reasonCode: "model_unavailable", state: "FAILED", trigger: "schedule" },
      result: null,
      task: { pauseReason: "model_unavailable" }
    });
  });

  it("reads only the owner's ready files, within the bound", async () => {
    const userId = await owner();
    const file = await prisma.attachment.create({ data: {
      byteSize: 5, fileName: "report.txt", kind: "file", metadata: {}, mimeType: "text/plain", storageKey: `synthetic/${randomUUID()}`, userId
    } });
    objects.set(file.storageKey, Buffer.from("bytes"));
    expect(await store.readFile({ attachmentId: file.id, maxBytes: 1024, userId })).toEqual(Buffer.from("bytes"));
    expect(await store.readFile({ attachmentId: file.id, maxBytes: 1024, userId: await owner() })).toBeNull();
    expect(await store.readFile({ attachmentId: file.id, maxBytes: 4, userId })).toBeNull();
    objects.clear();
    expect(await store.readFile({ attachmentId: file.id, maxBytes: 1024, userId })).toBeNull();
  });

  it("goes with its task (cascade)", async () => {
    const userId = await owner();
    const brief = await task(userId);
    const { occurrence } = await completedRun(userId, brief.id);
    await store.enqueue(occurrence.id, NOW);
    await prisma.scheduledTask.delete({ where: { id: brief.id } });
    expect(await prisma.telegramScheduledDelivery.count({ where: { userId } })).toBe(0);
  });
});
