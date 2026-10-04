import { describe, expect, it } from "vitest";
import { decodeScheduledTask, type ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import {
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
    id: "task-1", title: "Morning brief", prompt: "Synthetic prompt", timeZone: "Europe/Moscow", modelId: "model-1",
    provider: "connection-1", searchEnabled: false, emailNotify: true, toolsEnabled: true, workspaceEnabled: false, chatMode: "NEW",
    kind: "STANDARD", status: "ACTIVE", pauseReason: null, completionReason: null,
    nextRunAt: new Date("2026-10-05T06:00:00.000Z"), chatId: "chat-1", revision: 4,
    createdAt: new Date("2026-10-01T00:00:00.000Z"), updatedAt: new Date("2026-10-02T06:01:00.000Z"),
    chat: { permanentDeletionAt: null }, ...overrides
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
      schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, toolsEnabled: true, workspaceEnabled: false
    });
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
});
