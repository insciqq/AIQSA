import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { decodeScheduledTask, type ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import { scheduledPromptUrlDigests } from "./promptUrls";
import {
  loadScheduledTaskActivity,
  scheduledTaskScheduleColumns,
  scheduledTaskScheduleFromColumns,
  toScheduledTask,
  type ScheduledTaskRow
} from "./store";

const schedules: ScheduledTaskSchedule[] = [
  { kind: "once", date: "2026-10-12", time: "10:00" },
  { kind: "daily", time: "00:00" },
  { kind: "weekly", time: "23:59", days: ["mon", "wed", "sun"] },
  { kind: "monthly", time: "08:05", dayOfMonth: 31 },
  { kind: "hourly", everyHours: 2, time: "09:30", until: "18:00", days: ["mon", "fri"] },
  { kind: "hourly", everyHours: 12, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }
];

function row(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    ...scheduledTaskScheduleColumns({ kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }),
    scheduleEnabled: true, webhookEnabled: false, webhook: null,
    id: "task-1", title: "Morning brief", prompt: "Synthetic prompt", timeZone: "Europe/Moscow", modelId: "model-1",
    provider: "connection-1", searchEnabled: false, emailNotify: true, telegramNotify: true, toolsEnabled: true, workspaceEnabled: false,
    memoryEnabled: true, pinnedSkillIds: [], chatMode: "NEW", historyRetentionDays: 90, historyDeletedChats: 0,
    kind: "STANDARD", status: "ACTIVE", pauseReason: null, completionReason: null,
    nextRunAt: new Date("2026-10-05T06:00:00.000Z"), chatId: "chat-1", revision: 4,
    createdAt: new Date("2026-10-01T00:00:00.000Z"), updatedAt: new Date("2026-10-02T06:01:00.000Z"),
    promptUrlDigests: [], chat: { permanentDeletionAt: null }, ...overrides
  };
}

describe("scheduled task storage mapping", () => {
  it("round-trips every schedule kind through its columns", () => {
    for (const schedule of schedules) expect(scheduledTaskScheduleFromColumns(scheduledTaskScheduleColumns(schedule))).toEqual(schedule);
    expect(scheduledTaskScheduleColumns(schedules[2]!)).toEqual({
      dayOfMonth: null, daysOfWeekMask: 0b1000101, everyHours: null, onceLocalDate: null, scheduleKind: "WEEKLY",
      timeOfDayMinutes: 1439, untilMinutes: null
    });
    // An hourly window starts at the time of day and ends at `untilMinutes`.
    expect(scheduledTaskScheduleColumns(schedules[4]!)).toEqual({
      dayOfMonth: null, daysOfWeekMask: 0b0010001, everyHours: 2, onceLocalDate: null, scheduleKind: "HOURLY",
      timeOfDayMinutes: 570, untilMinutes: 1080
    });
  });

  it("projects a decodable wire task and withholds a chat fenced for deletion", () => {
    const task = toScheduledTask(row(), { lastRun: null, running: true, unseen: true });
    expect(decodeScheduledTask(task)).toEqual(task);
    expect(task).toMatchObject({
      chatId: "chat-1", chatMode: "new", nextRunAt: "2026-10-05T06:00:00.000Z", running: true, status: "active", unseenResult: true,
      schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, toolsEnabled: true, workspaceEnabled: false,
      memoryEnabled: true, emailNotify: true, telegramNotify: true
    });
    expect(toScheduledTask(row({ memoryEnabled: false }), { lastRun: null, running: false, unseen: false }).memoryEnabled).toBe(false);
    expect(toScheduledTask(row({ telegramNotify: false }), { lastRun: null, running: false, unseen: false }).telegramNotify).toBe(false);
    expect(toScheduledTask(row({ chat: { permanentDeletionAt: new Date() } }), { lastRun: null, running: false, unseen: false }).chatId)
      .toBeNull();
    expect(toScheduledTask(row({ chat: null, chatId: null, nextRunAt: null, status: "PAUSED" }),
      { lastRun: null, running: false, unseen: false })).toMatchObject({ chatId: null, nextRunAt: null, status: "paused", unseenResult: false });
    const hourly = toScheduledTask(row({ ...scheduledTaskScheduleColumns(schedules[4]!), chatMode: "SAME" }),
      { lastRun: null, running: false, unseen: false });
    expect(decodeScheduledTask(hourly)).toEqual(hourly);
    expect(hourly).toMatchObject({ chatMode: "same", schedule: schedules[4] });
    // A monitoring task that reached its goal: completed with why, and decodable.
    const reached = toScheduledTask(row({ chatMode: "SAME", completionReason: "goal_reached", kind: "MONITORING", nextRunAt: null,
      status: "COMPLETED" }), { lastRun: null, running: false, unseen: true });
    expect(decodeScheduledTask(reached)).toEqual(reached);
    expect(reached).toMatchObject({ completionReason: "goal_reached", kind: "monitoring", status: "completed" });
  });

  it("flags instructions whose links runs cannot read yet, without exposing the snapshot", () => {
    const prompt = "Summarize https://news.example/today";
    const pending = toScheduledTask(row({ prompt }), { lastRun: null, running: false, unseen: false });
    expect(pending.promptLinksPending).toBe(true);
    expect(decodeScheduledTask(pending)).toEqual(pending);
    expect(JSON.stringify(pending)).not.toMatch(/[0-9a-f]{64}/u);
    const allowed = toScheduledTask(row({ prompt, promptUrlDigests: [...scheduledPromptUrlDigests(prompt, { kind: "owner" })] }),
      { lastRun: null, running: false, unseen: false });
    expect(allowed).not.toHaveProperty("promptLinksPending");
  });

  it("flags the newest run's own unread result beside the task's unread aggregate", async () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 8, minute));
    // Both tasks still have an older unread answer. The newest run of "alert" is a
    // source alert the runner marked unread; the newest run of "quiet" is a check with no update.
    const settled = [
      { taskId: "alert", scheduledFor: at(0), state: "COMPLETED", reasonCode: "could_not_check", finishedAt: at(1), unseenAt: at(1) },
      { taskId: "quiet", scheduledFor: at(0), state: "COMPLETED", reasonCode: "no_update", finishedAt: at(2), unseenAt: null }
    ];
    const findMany = vi.fn(async ({ where }: { where: { unseenAt?: unknown } }) =>
      where.unseenAt ? [{ taskId: "alert" }, { taskId: "quiet" }] : []);
    // The settled runs, then the history retention's next deletion per task.
    const $queryRaw = vi.fn().mockResolvedValueOnce(settled).mockResolvedValueOnce([{ dueAt: at(30), taskId: "alert" }]);
    const groupBy = vi.fn().mockResolvedValue([]);
    const client = { $queryRaw, scheduledTaskOccurrence: { findMany }, scheduledTaskWebhookEvent: { groupBy } };
    const activity = await loadScheduledTaskActivity(client as unknown as PrismaClient, "user-1", ["alert", "quiet", "idle"]);
    expect(activity.get("alert")).toEqual({
      historyNextDeletionAt: at(30).toISOString(),
      lastRun: { scheduledFor: at(0).toISOString(), state: "completed", reasonCode: "could_not_check", finishedAt: at(1).toISOString(),
        unseen: true },
      running: false, unseen: true
    });
    expect(activity.get("quiet")).toMatchObject({ historyNextDeletionAt: null, lastRun: { reasonCode: "no_update", unseen: false },
      unseen: true });
    expect(activity.get("idle")).toEqual({ historyNextDeletionAt: null, lastRun: null, running: false, unseen: false });
    expect(toScheduledTask(row(), activity.get("alert")!)).toMatchObject({ historyDeletedChats: 0,
      historyNextDeletionAt: at(30).toISOString(), historyRetentionDays: 90 });
    const task = toScheduledTask(row(), activity.get("quiet")!);
    expect(decodeScheduledTask(task)).toEqual(task);
    expect(task).toMatchObject({ lastRun: { unseen: false }, unseenResult: true });
  });

  it("projects the trigger switches and the webhook's address, issue time and waiting events, never its token", async () => {
    const webhook = { lastEventAt: new Date("2026-10-25T09:30:00.000Z"), publicId: "AbCdEfGhIjKlMnOpQrSt_-",
      tokenIssuedAt: new Date("2026-10-25T08:00:00.000Z") };
    const hooked = row({ nextRunAt: null, scheduleEnabled: false, webhook, webhookEnabled: true });
    const groupBy = vi.fn().mockResolvedValue([{ _count: { _all: 3 }, taskId: "task-1" }]);
    const client = { $queryRaw: vi.fn().mockResolvedValue([]), scheduledTaskOccurrence: { findMany: vi.fn().mockResolvedValue([]) },
      scheduledTaskWebhookEvent: { groupBy } };
    const activity = await loadScheduledTaskActivity(client as unknown as PrismaClient, "user-1", ["task-1"]);
    // Only events still waiting for their run count, and only the owner's.
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { state: "QUEUED", taskId: { in: ["task-1"] }, userId: "user-1" }
    }));
    const task = toScheduledTask(hooked, activity.get("task-1")!);
    expect(decodeScheduledTask(task)).toEqual(task);
    expect(task).toMatchObject({
      nextRunAt: null, scheduleEnabled: false, webhookEnabled: true,
      webhook: { lastEventAt: "2026-10-25T09:30:00.000Z", path: "/api/automations/hooks/AbCdEfGhIjKlMnOpQrSt_-",
        queuedEvents: 3, tokenIssuedAt: "2026-10-25T08:00:00.000Z" }
    });
    // A projection without activity (a card, a tool result) counts no waiting events; a task never on a webhook has none.
    expect(toScheduledTask(hooked, { lastRun: null, running: false, unseen: false }).webhook)
      .toMatchObject({ queuedEvents: 0, tokenIssuedAt: "2026-10-25T08:00:00.000Z" });
    expect(toScheduledTask(row(), { lastRun: null, running: false, unseen: false })).toMatchObject({
      scheduleEnabled: true, webhook: null, webhookEnabled: false
    });
    // A webhook whose trigger is off keeps its address; one without a token yet says so.
    const kept = toScheduledTask(row({ webhook: { ...webhook, tokenIssuedAt: null } }), { lastRun: null, running: false, unseen: false });
    expect(decodeScheduledTask(kept)).toEqual(kept);
    expect(kept.webhook).toMatchObject({ path: "/api/automations/hooks/AbCdEfGhIjKlMnOpQrSt_-", tokenIssuedAt: null });
  });
});
