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
  { kind: "monthly", time: "08:05", dayOfMonth: 31 }
];

function row(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    ...scheduledTaskScheduleColumns({ kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }),
    id: "task-1", title: "Morning brief", prompt: "Synthetic prompt", timeZone: "Europe/Moscow", modelId: "model-1",
    provider: "connection-1", searchEnabled: false, emailNotify: true, status: "ACTIVE", pauseReason: null,
    nextRunAt: new Date("2026-10-05T06:00:00.000Z"), chatId: "chat-1", unseenResultAt: new Date("2026-10-02T06:01:00.000Z"),
    revision: 4, createdAt: new Date("2026-10-01T00:00:00.000Z"), updatedAt: new Date("2026-10-02T06:01:00.000Z"),
    chat: { permanentDeletionAt: null }, ...overrides
  };
}

describe("scheduled task storage mapping", () => {
  it("round-trips every schedule kind through its columns", () => {
    for (const schedule of schedules) expect(scheduledTaskScheduleFromColumns(scheduledTaskScheduleColumns(schedule))).toEqual(schedule);
    expect(scheduledTaskScheduleColumns(schedules[2]!)).toEqual({
      dayOfMonth: null, daysOfWeekMask: 0b1000101, onceLocalDate: null, scheduleKind: "WEEKLY", timeOfDayMinutes: 1439
    });
  });

  it("projects a decodable wire task and withholds a chat fenced for deletion", () => {
    const task = toScheduledTask(row(), { lastRun: null, running: true });
    expect(decodeScheduledTask(task)).toEqual(task);
    expect(task).toMatchObject({
      chatId: "chat-1", nextRunAt: "2026-10-05T06:00:00.000Z", running: true, status: "active", unseenResult: true,
      schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }
    });
    expect(toScheduledTask(row({ chat: { permanentDeletionAt: new Date() } }), { lastRun: null, running: false }).chatId).toBeNull();
    expect(toScheduledTask(row({ chat: null, chatId: null, nextRunAt: null, status: "PAUSED", unseenResultAt: null }),
      { lastRun: null, running: false })).toMatchObject({ chatId: null, nextRunAt: null, status: "paused", unseenResult: false });
  });
});
