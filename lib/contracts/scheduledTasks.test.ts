import { describe, expect, it } from "vitest";
import { CHAT_TITLE_MAX_LENGTH } from "./chats";
import {
  SCHEDULED_TASK_ERROR_CODES,
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  decodeScheduledTask,
  decodeScheduledTaskDetailResponse,
  decodeScheduledTaskListResponse,
  isScheduledTaskPrompt,
  normalizeScheduledTaskTitle,
  scheduledTaskErrorMessage,
  scheduledTaskReasonMessage,
  type ScheduledTask
} from "./scheduledTasks";

const task: ScheduledTask = {
  id: "task-1", title: "Morning brief", prompt: "Summarize overnight news.",
  schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow",
  modelId: "model-1", provider: "connection-1", searchEnabled: true, emailNotify: false, status: "active",
  pauseReason: null, nextRunAt: "2026-10-05T06:00:00.000Z",
  lastRun: { scheduledFor: "2026-10-02T06:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-02T06:01:10.000Z" },
  running: false, chatId: "chat-1", unseenResult: true, revision: 3,
  createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-10-02T06:01:10.000Z"
};

describe("scheduled task wire contract", () => {
  it("bounds titles like the chat title they become, in code points", () => {
    expect(SCHEDULED_TASK_TITLE_MAX_LENGTH).toBe(CHAT_TITLE_MAX_LENGTH);
    expect(normalizeScheduledTaskTitle("  Brief  ")).toBe("Brief");
    expect(normalizeScheduledTaskTitle("😀".repeat(120))).toBe("😀".repeat(120));
    for (const title of ["   ", "😀".repeat(121), "a\0b", 7]) expect(normalizeScheduledTaskTitle(title)).toBeNull();
    expect(isScheduledTaskPrompt("😀".repeat(SCHEDULED_TASK_PROMPT_MAX_LENGTH))).toBe(true);
    for (const prompt of [" \n ", "😀".repeat(SCHEDULED_TASK_PROMPT_MAX_LENGTH + 1), "a\0", null]) {
      expect(isScheduledTaskPrompt(prompt)).toBe(false);
    }
  });

  it("decodes exact task projections and rejects inconsistent ones", () => {
    expect(decodeScheduledTask(task)).toEqual(task);
    expect(decodeScheduledTask({ ...task, status: "paused", nextRunAt: null, pauseReason: "model_unavailable" }))
      .toMatchObject({ status: "paused", pauseReason: "model_unavailable" });
    for (const candidate of [
      { ...task, extra: true }, { ...task, status: "paused" }, { ...task, title: " Morning brief" },
      { ...task, lastRun: { ...task.lastRun, state: "running" } }, { ...task, pauseReason: "Not a code" },
      { ...task, revision: 0 }, { ...task, schedule: { kind: "daily", time: "25:00" } }, { ...task, timeZone: "+03:00" }
    ]) {
      expect(decodeScheduledTask(candidate)).toBeNull();
    }
  });

  it("decodes list and detail responses", () => {
    const list = { tasks: [task], limits: { maxActive: 10, maxTotal: 50 }, emailAvailable: false };
    expect(decodeScheduledTaskListResponse(list)).toEqual(list);
    expect(decodeScheduledTaskListResponse({ ...list, tasks: [task, task] })).toBeNull();
    const run = { scheduledFor: "2026-10-02T06:00:00.000Z", trigger: "schedule", state: "skipped", reasonCode: "missed",
      startedAt: null, finishedAt: "2026-10-02T19:00:00.000Z", chatId: null };
    expect(decodeScheduledTaskDetailResponse({ task, recentRuns: [run] })).toEqual({ task, recentRuns: [run] });
    expect(decodeScheduledTaskDetailResponse({ task, recentRuns: [{ ...run, trigger: "retry" }] })).toBeNull();
  });

  it("has copy for every API error and reason fallbacks", () => {
    const messages = SCHEDULED_TASK_ERROR_CODES.map(scheduledTaskErrorMessage);
    expect(new Set(messages).size).toBe(SCHEDULED_TASK_ERROR_CODES.length);
    expect(scheduledTaskErrorMessage("anything_else")).toBe(scheduledTaskErrorMessage("scheduled_tasks_unavailable"));
    expect(scheduledTaskReasonMessage(null)).toBeNull();
    expect(scheduledTaskReasonMessage("repeated_failures")).toContain("three");
    expect(scheduledTaskReasonMessage("some_future_code")).toBe("The run did not complete.");
  });
});
