// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ScheduledTaskDraft } from "../../contracts/scheduledTasks";
import { prisma } from "../prisma";
import { createPrismaScheduledTaskStore, scheduledTaskScheduleColumns, ScheduledTaskError } from "./store";

const users: string[] = [];
const store = createPrismaScheduledTaskStore(prisma);
const draft: ScheduledTaskDraft = {
  title: "Synthetic brief", prompt: "Synthetic scheduled prompt", schedule: { kind: "daily", time: "09:00" },
  timeZone: "Europe/Moscow", modelId: "fake-qsa", provider: "fake", searchEnabled: false, emailNotify: false
};
const due = new Date("2026-10-05T06:00:00.000Z");

async function owner(): Promise<string> {
  const id = `scheduled-tasks-test-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic scheduled tasks", id, status: "active" } });
  users.push(id);
  return id;
}
function rows(userId: string, count: number, status: "ACTIVE" | "PAUSED") {
  return Array.from({ length: count }, (_value, index) => ({
    ...scheduledTaskScheduleColumns(draft.schedule), emailNotify: false, modelId: draft.modelId, nextRunAt: status === "ACTIVE" ? due : null,
    prompt: draft.prompt, provider: draft.provider, searchEnabled: false, status, timeZone: draft.timeZone, title: `Seed ${index}`, userId
  }));
}
function limitFailures(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === "rejected" && result.reason instanceof ScheduledTaskError &&
    result.reason.code === "scheduled_task_limit").length;
}

afterEach(async () => {
  const ids = users.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted scheduled tasks", () => {
  it("enforces the active and total limits under concurrent creation", async () => {
    const userId = await owner();
    for (let index = 0; index < 9; index += 1) await store.create(userId, { ...draft, title: `Task ${index}` }, due);
    const active = await Promise.allSettled(["Last A", "Last B"].map((title) => store.create(userId, { ...draft, title }, due)));
    expect(active.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(limitFailures(active)).toBe(1);
    expect(await prisma.scheduledTask.count({ where: { status: "ACTIVE", userId } })).toBe(10);

    const saved = await owner();
    await prisma.scheduledTask.createMany({ data: rows(saved, 49, "PAUSED") });
    const total = await Promise.allSettled(["Last A", "Last B"].map((title) => store.create(saved, { ...draft, title }, due)));
    expect(limitFailures(total)).toBe(1);
    expect(await prisma.scheduledTask.count({ where: { userId: saved } })).toBe(50);
  });

  it("guards updates by revision, counts activation and keeps an unchanged due time", async () => {
    const userId = await owner();
    const task = await store.create(userId, draft, due);
    const paused = await store.update(userId, task.id, { draft, expectedRevision: 1, nextRunAt: null, status: "paused" });
    expect(paused).toMatchObject({ nextRunAt: null, revision: 2, status: "paused" });
    await prisma.scheduledTask.createMany({ data: rows(userId, 10, "ACTIVE") });
    await expect(store.update(userId, task.id, { draft, expectedRevision: 2, nextRunAt: due, status: "active" }))
      .rejects.toMatchObject({ code: "scheduled_task_limit" });
    await prisma.scheduledTask.deleteMany({ where: { title: { startsWith: "Seed" }, userId } });
    const resumed = await store.update(userId, task.id, { draft, expectedRevision: 2, nextRunAt: due, status: "active" });
    expect(resumed).toMatchObject({ nextRunAt: due.toISOString(), revision: 3, status: "active" });

    // Runner bookkeeping keeps the revision; a runner status transition bumps it.
    const advanced = new Date("2026-10-06T06:00:00.000Z");
    await prisma.scheduledTask.update({ data: { consecutiveFailures: 2, nextRunAt: advanced }, where: { id: task.id } });
    const renamed = await store.update(userId, task.id, {
      draft: { ...draft, title: "Renamed" }, expectedRevision: 3, nextRunAt: undefined, status: "active"
    });
    expect(renamed).toMatchObject({ nextRunAt: advanced.toISOString(), revision: 4, title: "Renamed" });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ consecutiveFailures: 0 });
    await prisma.scheduledTask.update({
      data: { nextRunAt: null, pauseReason: "model_unavailable", revision: { increment: 1 }, status: "PAUSED" }, where: { id: task.id }
    });
    await expect(store.update(userId, task.id, { draft, expectedRevision: 4, nextRunAt: due, status: "active" }))
      .rejects.toMatchObject({ code: "scheduled_task_stale" });
    expect(await store.get(userId, task.id)).toMatchObject({ pauseReason: "model_unavailable", revision: 5, status: "paused" });
  });

  it("projects the newest settled run, open runs and owner-scoped history", async () => {
    const userId = await owner(), other = await owner();
    const task = await store.create(userId, draft, due);
    const at = (hours: number) => new Date(Date.UTC(2026, 9, 1, hours));
    await prisma.scheduledTaskOccurrence.createMany({ data: [
      { finishedAt: at(20), reasonCode: "missed", scheduledFor: at(6), state: "SKIPPED", taskId: task.id, trigger: "schedule", userId },
      { finishedAt: at(31), scheduledFor: at(30), startedAt: at(30), state: "COMPLETED", taskId: task.id, trigger: "schedule", userId },
      { scheduledFor: at(40), startedAt: at(40), state: "RUNNING", taskId: task.id, trigger: "manual", userId }
    ] });
    await prisma.scheduledTask.update({ data: { unseenResultAt: at(31) }, where: { id: task.id } });
    const projected = await store.get(userId, task.id);
    expect(projected).toMatchObject({
      lastRun: { finishedAt: at(31).toISOString(), reasonCode: null, scheduledFor: at(30).toISOString(), state: "completed" },
      running: true, unseenResult: true
    });
    const detail = await store.detail(userId, task.id);
    expect(detail?.recentRuns.map((run) => [run.trigger, run.state])).toEqual([["manual", "running"], ["schedule", "completed"], ["schedule", "skipped"]]);
    expect((await store.list(userId)).tasks).toEqual([projected]);
    expect(await store.markSeen(userId, task.id)).toBe(true);
    expect(await store.get(userId, task.id)).toMatchObject({ unseenResult: false });

    expect(await store.get(other, task.id)).toBeNull();
    expect(await store.detail(other, task.id)).toBeNull();
    expect(await store.markSeen(other, task.id)).toBe(false);
    expect(await store.delete(other, task.id)).toBe(false);
    await expect(store.update(other, task.id, { draft, expectedRevision: 1, nextRunAt: null, status: "paused" }))
      .rejects.toMatchObject({ code: "scheduled_task_not_found" });
    expect(await store.delete(userId, task.id)).toBe(true);
    expect(await prisma.scheduledTaskOccurrence.count({ where: { taskId: task.id } })).toBe(0);
  });

  it("clears only chat references when the chat is deleted and binds personal chats of the owner only", async () => {
    const userId = await owner(), other = await owner();
    const task = await store.create(userId, draft, due);
    const chat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: draft.title, userId } });
    const foreign = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Other", userId: other } });
    await prisma.scheduledTask.update({ data: { chatId: chat.id }, where: { id: task.id } });
    await prisma.scheduledTaskOccurrence.create({ data: {
      chatId: chat.id, finishedAt: due, scheduledFor: due, state: "COMPLETED", taskId: task.id, trigger: "schedule", userId
    } });
    await expect(prisma.scheduledTask.update({ data: { chatId: foreign.id }, where: { id: task.id } })).rejects.toMatchObject({ code: "P2003" });
    expect(await store.get(userId, task.id)).toMatchObject({ chatId: chat.id });
    expect((await store.detail(userId, task.id))?.recentRuns).toMatchObject([{ chatId: chat.id }]);

    await prisma.chat.delete({ where: { id: chat.id } });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ chatId: null, userId });
    expect(await prisma.scheduledTaskOccurrence.findFirstOrThrow({ where: { taskId: task.id } }))
      .toMatchObject({ chatId: null, state: "COMPLETED", userId });
  });

  it("removes tasks and their history with the account and rejects inconsistent rows", async () => {
    const userId = await owner();
    const task = await store.create(userId, draft, due);
    await prisma.scheduledTaskOccurrence.create({ data: { scheduledFor: due, taskId: task.id, trigger: "schedule", userId } });
    await expect(prisma.scheduledTask.update({ data: { status: "PAUSED" }, where: { id: task.id } }))
      .rejects.toThrow("ScheduledTask_state_check");
    await expect(prisma.scheduledTask.update({ data: { onceLocalDate: "2026-10-12" }, where: { id: task.id } }))
      .rejects.toThrow("ScheduledTask_schedule_check");
    await expect(prisma.scheduledTaskOccurrence.updateMany({ data: { state: "COMPLETED" }, where: { taskId: task.id } }))
      .rejects.toThrow("ScheduledTaskOccurrence_finished_check");

    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.scheduledTask.count({ where: { userId } })).toBe(0);
    expect(await prisma.scheduledTaskOccurrence.count({ where: { userId } })).toBe(0);
  });
});
