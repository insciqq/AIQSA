import { describe, expect, it } from "vitest";
import { CHAT_TITLE_MAX_LENGTH } from "./chats";
import {
  SCHEDULED_TASK_ERROR_CODES,
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_SEEN_RUNS_LIMIT,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  decodeScheduledTask,
  decodeScheduledTaskDetailResponse,
  decodeScheduledTaskListResponse,
  decodeScheduledTaskSeenRequest,
  isScheduledTaskPrompt,
  normalizeScheduledTaskTitle,
  scheduledTaskChatModeAllowed,
  scheduledTaskErrorMessage,
  scheduledTaskReasonMessage,
  type ScheduledTask
} from "./scheduledTasks";

const task: ScheduledTask = {
  id: "task-1", title: "Morning brief", prompt: "Summarize overnight news.",
  schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow",
  modelId: "model-1", provider: "connection-1", searchEnabled: true, emailNotify: false, chatMode: "new", status: "active",
  pauseReason: null, nextRunAt: "2026-10-05T06:00:00.000Z",
  lastRun: { scheduledFor: "2026-10-02T06:00:00.000Z", state: "completed", reasonCode: null, finishedAt: "2026-10-02T06:01:10.000Z" },
  running: false, chatId: "chat-1", unseenResult: true, revision: 3,
  createdAt: "2026-09-30T10:00:00.000Z", updatedAt: "2026-10-02T06:01:10.000Z"
};
const hourly = { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] } as const;

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
    expect(decodeScheduledTask({ ...task, schedule: hourly, chatMode: "same" })).toMatchObject({ schedule: hourly, chatMode: "same" });
    for (const candidate of [
      { ...task, extra: true }, { ...task, status: "paused" }, { ...task, title: " Morning brief" },
      { ...task, lastRun: { ...task.lastRun, state: "running" } }, { ...task, pauseReason: "Not a code" },
      { ...task, revision: 0 }, { ...task, schedule: { kind: "daily", time: "25:00" } }, { ...task, timeZone: "+03:00" },
      { ...task, chatMode: "other" }, { ...task, chatMode: undefined }, { ...task, schedule: hourly, chatMode: "new" }
    ]) {
      expect(decodeScheduledTask(candidate)).toBeNull();
    }
  });

  it("keeps hourly tasks in one chat and lets other kinds start a chat per run", () => {
    expect(scheduledTaskChatModeAllowed(hourly, "same")).toBe(true);
    expect(scheduledTaskChatModeAllowed(hourly, "new")).toBe(false);
    for (const schedule of [{ kind: "daily", time: "09:00" }, { kind: "once", date: "2026-10-12", time: "09:00" }] as const) {
      expect(scheduledTaskChatModeAllowed(schedule, "new")).toBe(true);
      expect(scheduledTaskChatModeAllowed(schedule, "same")).toBe(true);
    }
  });

  it("decodes list and detail responses", () => {
    const list = { tasks: [task], limits: { maxActive: 10, maxTotal: 50, maxActiveHourly: 3 }, emailAvailable: false };
    expect(decodeScheduledTaskListResponse(list)).toEqual(list);
    expect(decodeScheduledTaskListResponse({ ...list, tasks: [task, task] })).toBeNull();
    expect(decodeScheduledTaskListResponse({ ...list, limits: { maxActive: 10, maxTotal: 50 } })).toBeNull();
    const run = { id: "run-1", scheduledFor: "2026-10-02T06:00:00.000Z", trigger: "schedule", state: "skipped",
      reasonCode: "previous_running", startedAt: null, finishedAt: "2026-10-02T19:00:00.000Z", chatId: null, unseen: false };
    const result = { ...run, id: "run-2", state: "completed", reasonCode: null, chatId: "chat-1", unseen: true };
    expect(decodeScheduledTaskDetailResponse({ task, recentRuns: [result, run] })).toEqual({ task, recentRuns: [result, run] });
    for (const malformed of [{ ...run, trigger: "retry" }, { ...run, id: "" }, { ...run, unseen: "no" },
      { ...run, state: "running", finishedAt: null, unseen: true }, { id: run.id, scheduledFor: run.scheduledFor }]) {
      expect(decodeScheduledTaskDetailResponse({ task, recentRuns: [malformed] })).toBeNull();
    }
  });

  it("names the rendered results a mark-seen request clears", () => {
    expect(decodeScheduledTaskSeenRequest({ runIds: ["run-1", "run-2"] })).toEqual({ runIds: ["run-1", "run-2"] });
    const tooMany = Array.from({ length: SCHEDULED_TASK_SEEN_RUNS_LIMIT + 1 }, (_value, index) => `run-${index}`);
    for (const body of [{}, { runIds: [] }, { runIds: ["run-1", "run-1"] }, { runIds: [""] }, { runIds: "run-1" },
      { runIds: ["run-1"], all: true }, { runIds: tooMany }, null, []]) {
      expect(decodeScheduledTaskSeenRequest(body)).toBeNull();
    }
  });

  it("has copy for every API error and reason fallbacks", () => {
    const messages = SCHEDULED_TASK_ERROR_CODES.map(scheduledTaskErrorMessage);
    expect(new Set(messages).size).toBe(SCHEDULED_TASK_ERROR_CODES.length);
    expect(scheduledTaskErrorMessage("anything_else")).toBe(scheduledTaskErrorMessage("scheduled_tasks_unavailable"));
    expect(scheduledTaskErrorMessage("scheduled_task_hourly_limit")).toContain("3 active hourly tasks");
    expect(scheduledTaskReasonMessage(null)).toBeNull();
    expect(scheduledTaskReasonMessage("repeated_failures")).toContain("three");
    expect(scheduledTaskReasonMessage("previous_running")).toBe("Skipped: the previous run was still in progress.");
    expect(scheduledTaskReasonMessage("superseded")).toContain("newer scheduled time");
    expect(scheduledTaskReasonMessage("some_future_code")).toBe("The run did not complete.");
  });
});
