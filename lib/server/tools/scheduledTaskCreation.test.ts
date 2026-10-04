import { describe, expect, it, vi } from "vitest";
import type { ScheduledTask } from "../../contracts/scheduledTasks";
import { logEvent } from "../observability";
import { readOnlyRunTool } from "../runs/toolReadOnly";
import type { ScheduledTaskCallCreation } from "../runs/runRepositoryContract";
import {
  CREATE_SCHEDULED_TASK_TOOL_NAME,
  createScheduledTaskTool,
  executeCreateScheduledTask,
  isScheduledTaskCreateCall,
  isScheduledTaskToolSettings,
  scheduledTaskCreatedResult,
  scheduledTaskToolsForRequest,
  type ScheduledTaskCallCreator,
  type ScheduledTaskToolSettings
} from "./scheduledTaskCreation";
import { invalidProviderToolArguments } from "./types";

vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(), logEvent: vi.fn()
}));

const settings: ScheduledTaskToolSettings = {
  modelId: "deployment-1", provider: "connection-1", searchEnabled: true, toolsEnabled: true, workspaceEnabled: false
};
const request = (zone: Readonly<{ timeZone: string; timeZoneSource: "client" | "utc_fallback" }> = {
  timeZone: "Europe/Moscow", timeZoneSource: "client"
}) => ({ prompt: { baseline: zone }, scheduledTaskTool: settings });
const context = (overrides: Partial<Parameters<typeof executeCreateScheduledTask>[1]> = {}) => ({
  persistedToolCallId: "persisted-call-1", request: request(), runId: "run-1", userId: "user-1", ...overrides
});
const weekdays = { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"], date: null, dayOfMonth: null,
  everyHours: null, until: null };
const call = (args: Record<string, unknown>) => ({ arguments: args, id: "provider-call-1", name: CREATE_SCHEDULED_TASK_TOOL_NAME });
const reminder = { title: "Check mail", prompt: "Remind me to check my mail.", kind: "standard", chatMode: null, schedule: weekdays };

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1", title: "Check mail", prompt: "Remind me to check my mail.",
    schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow",
    modelId: "deployment-1", provider: "connection-1", searchEnabled: true, emailNotify: false, toolsEnabled: true,
    workspaceEnabled: false, chatMode: "new", kind: "standard", status: "active", pauseReason: null, completionReason: null,
    nextRunAt: "2026-10-05T06:00:00.000Z", lastRun: null, running: false, chatId: null, unseenResult: false, revision: 1,
    createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z", ...overrides
  };
}

/** A creator standing in for the repository: it creates the task and returns the call's result for it. */
function creator(created: ScheduledTask = task()) {
  return vi.fn<ScheduledTaskCallCreator>(async (input) => ({ kind: "created", result: input.result(created), task: created }));
}

describe("create_scheduled_task tool", () => {
  it("is a strict server-owned write offered only with the frozen marker, naming the run's zone", () => {
    const tool = createScheduledTaskTool("Europe/Moscow");
    expect(tool).toMatchObject({ capability: "session", name: "create_scheduled_task", strict: true, inputSchema: {
      additionalProperties: false, required: ["title", "prompt", "kind", "chatMode", "schedule"],
      properties: { schedule: { additionalProperties: false,
        required: ["kind", "time", "date", "days", "dayOfMonth", "everyHours", "until"] } }
    } });
    for (const phrase of ["time zone Europe/Moscow", "\"monitoring\" when", "\"standard\" for reminders",
      "at most once per answer", "do not ask for confirmation", "without this conversation"]) {
      expect(tool.description).toContain(phrase);
    }
    expect(scheduledTaskToolsForRequest(request()).map((entry) => entry.description)).toEqual([tool.description]);
    expect(scheduledTaskToolsForRequest({ prompt: {} })).toEqual([]);
    // Without a frozen browser zone the run's UTC fallback is the schedule's zone.
    expect(scheduledTaskToolsForRequest({ prompt: {}, scheduledTaskTool: settings })[0]?.description).toContain("time zone UTC");
    expect(isScheduledTaskCreateCall({ scheduledTaskTool: settings }, CREATE_SCHEDULED_TASK_TOOL_NAME)).toBe(true);
    expect(isScheduledTaskCreateCall({}, CREATE_SCHEDULED_TASK_TOOL_NAME)).toBe(false);
    expect(isScheduledTaskCreateCall({ scheduledTaskTool: settings }, "get_session_status")).toBe(false);
    // A creation changes state: repeated identical calls are never treated as reads.
    expect(readOnlyRunTool({ tools: [tool] })(CREATE_SCHEDULED_TASK_TOOL_NAME)).toBe(false);
  });

  it("decodes only the exact frozen settings", () => {
    expect(isScheduledTaskToolSettings(settings)).toBe(true);
    for (const value of [null, {}, { ...settings, extra: true }, { ...settings, modelId: "" }, { ...settings, toolsEnabled: "yes" },
      { ...settings, provider: "x".repeat(257) }]) {
      expect(isScheduledTaskToolSettings(value)).toBe(false);
    }
  });

  it("creates through the owner's rules with the run's frozen settings and zone and returns what to confirm", async () => {
    const create = creator();
    const result = await executeCreateScheduledTask(call(reminder), context(), create);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({ callId: "persisted-call-1", runId: "run-1", userId: "user-1", body: {
      title: "Check mail", prompt: "Remind me to check my mail.", kind: "standard", chatMode: "new", emailNotify: false,
      schedule: { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow",
      modelId: "deployment-1", provider: "connection-1", searchEnabled: true, toolsEnabled: true, workspaceEnabled: false
    } });
    // Only the fields of the schedule's kind reach the owner contract.
    expect(Object.keys(create.mock.calls[0]![0].body as Record<string, Record<string, unknown>>).sort()).toEqual([
      "chatMode", "emailNotify", "kind", "modelId", "prompt", "provider", "schedule", "searchEnabled", "timeZone", "title",
      "toolsEnabled", "workspaceEnabled"
    ]);
    expect(Object.keys((create.mock.calls[0]![0].body as { schedule: object }).schedule)).toEqual(["kind", "time", "days"]);
    expect(result).toEqual({
      artifacts: [{ type: "artifact", data: { artifactType: "scheduled_task", payload: {
        taskId: "task-1", title: "Check mail", kind: "standard", schedule: { kind: "weekly", time: "09:00",
          days: ["mon", "tue", "wed", "thu", "fri"] }, timeZone: "Europe/Moscow", timeZoneFallback: false, toolsEnabled: true,
        workspaceEnabled: false, status: "active", nextRunAt: "2026-10-05T06:00:00.000Z"
      } } }],
      callId: "provider-call-1",
      content: [{ type: "json", value: expect.objectContaining({ created: true, title: "Check mail",
        schedule: "Every weekday at 09:00", timeZone: "Europe/Moscow", nextRun: "Mon 2026-10-05 09:00",
        chat: "every run starts a new chat", webSearch: true, tools: true, workspace: false }) }],
      name: CREATE_SCHEDULED_TASK_TOOL_NAME,
      status: "complete"
    });
    expect(JSON.stringify(result.content)).not.toContain("task-1");
  });

  it("keeps an hourly monitor in one chat by default and marks a UTC fallback zone on the card", async () => {
    const monitor = task({ chatMode: "same", kind: "monitoring", timeZone: "UTC",
      schedule: { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } });
    const create = creator(monitor);
    const result = await executeCreateScheduledTask(call({
      title: "New tag", prompt: "Check whether a new tag of the repository was released.", kind: "monitoring",
      schedule: { kind: "hourly", time: "00:00", everyHours: 1, days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }
    }), context({ request: request({ timeZone: "UTC", timeZoneSource: "utc_fallback" }) }), create);
    expect(create.mock.calls[0]![0].body).toMatchObject({ chatMode: "same", kind: "monitoring", timeZone: "UTC",
      schedule: { kind: "hourly", everyHours: 1, time: "00:00", until: null } });
    expect(result.artifacts?.[0]).toMatchObject({ data: { payload: { timeZoneFallback: true, kind: "monitoring" } } });
  });

  it("refuses misplaced, unknown or unreadable arguments before anything is created", async () => {
    const create = creator();
    for (const [args, phrase] of [
      [{ ...reminder, schedule: { ...weekdays, kind: "daily" } }, "A daily schedule does not use days"],
      [{ ...reminder, schedule: { ...weekdays, kind: "every_day" } }, "schedule.kind must be"],
      [{ ...reminder, schedule: { ...weekdays, weekdays: true } }, "unknown field"],
      [{ ...reminder, priority: "high" }, "Use only the arguments"],
      [invalidProviderToolArguments(), "not a JSON object"]
    ] as const) {
      const result = await executeCreateScheduledTask(call(args as Record<string, unknown>), context(), create);
      expect(result.status).toBe("error");
      expect(result.content).toEqual([{ type: "json", value: { created: false, error: "scheduled_task_arguments_invalid",
        message: expect.stringContaining(phrase) } }]);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("explains every refusal as a tool error and creates nothing", async () => {
    for (const [code, phrase] of [
      ["scheduled_task_limit", "up to 10 active and 50 saved"],
      ["scheduled_task_hourly_limit", "up to 3 active hourly tasks"],
      ["scheduled_task_model_unavailable", "no longer available"],
      ["scheduled_task_schedule_invalid", "The schedule is invalid or never runs"],
      ["scheduled_task_once_in_past", "at least a minute from now"],
      ["scheduled_task_chat_mode_invalid", "always continue in the same chat"],
      ["scheduled_task_answer_limit", "already created a scheduled task"],
      ["scheduled_task_already_created", "An earlier answer to this message already created"],
      ["scheduled_task_call_unavailable", "cannot be created from this answer"]
    ] as const) {
      const create = vi.fn<ScheduledTaskCallCreator>(async () => ({ code, kind: "refused" }) as ScheduledTaskCallCreation);
      const result = await executeCreateScheduledTask(call(reminder), context(), create);
      expect(result).toEqual({ callId: "provider-call-1", content: [{ type: "json", value: { created: false, error: code,
        message: expect.stringContaining(phrase) } }], name: CREATE_SCHEDULED_TASK_TOOL_NAME, status: "error" });
      expect(result.artifacts).toBeUndefined();
    }
  });

  it("returns a settled call's own result on replay and reports an unavailable store", async () => {
    const stored = scheduledTaskCreatedResult(call(reminder), task(), false);
    const replay = vi.fn<ScheduledTaskCallCreator>(async () => ({ kind: "settled", result: stored }));
    expect(await executeCreateScheduledTask(call(reminder), context(), replay)).toBe(stored);
    const failing = vi.fn<ScheduledTaskCallCreator>(async () => { throw new Error("database_down"); });
    expect(await executeCreateScheduledTask(call(reminder), context(), failing)).toMatchObject({ status: "error",
      content: [{ type: "json", value: { created: false, error: "scheduled_tasks_unavailable" } }] });
    // The failure is logged by code only: never the title, prompt or schedule.
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", expect.objectContaining({
      code: "scheduled_tasks_unavailable", outcome: "failed" }));
    expect(JSON.stringify(vi.mocked(logEvent).mock.calls)).not.toMatch(/Check mail|mail\.|09:00/u);
  });

  it("creates nothing without the frozen marker, a creator or a persisted call", async () => {
    const create = creator();
    for (const [overrides, creatorInput] of [
      [{ request: { prompt: {} } }, create],
      [{}, undefined],
      [{ persistedToolCallId: undefined }, create],
      [{ userId: undefined }, create]
    ] as const) {
      const result = await executeCreateScheduledTask(call(reminder), context(overrides), creatorInput);
      expect(result).toMatchObject({ status: "error", content: [{ value: { error: "scheduled_task_call_unavailable" } }] });
    }
    expect(create).not.toHaveBeenCalled();
  });
});
