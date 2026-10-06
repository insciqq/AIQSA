import { describe, expect, it } from "vitest";
import type { ScheduledTask, ScheduledTaskRun } from "@/lib/contracts/scheduledTasks";
import {
  blankScheduledTaskDraft,
  sameScheduledTaskDraft,
  scheduledTaskCapabilityBlockers,
  scheduledTaskCreateRequest,
  scheduledTaskDraftFromTask,
  scheduledTaskDraftSchedule,
  scheduledTaskForcedChatReason,
  scheduledTaskMemoryAvailability,
  scheduledTaskPreview,
  scheduledTaskStartingTools,
  scheduledTaskUpdateRequest,
  scheduledTaskWorkspaceAvailability,
  validateScheduledTaskDraft
} from "./scheduledTaskDraft";
import { scheduledTaskCatalogFixture, scheduledTaskFixture } from "./scheduledTaskFixtures";
import {
  formatScheduledInstant,
  scheduledTaskFailureMessage,
  scheduledTaskLastRunLine,
  scheduledTaskResultNotice,
  scheduledTaskRunReasonText,
  scheduledTaskRunRow,
  scheduledTaskScheduleText,
  scheduledTaskStatusLine,
  scheduledTaskTimeZoneOptions,
  sortScheduledTasks
} from "./scheduledTaskPresentation";

const now = new Date("2026-10-04T10:00:00.000Z");
const catalog = scheduledTaskCatalogFixture();

describe("scheduled task presentation", () => {
  it("formats instants in the task's zone and adds the year only outside the current one", () => {
    expect(formatScheduledInstant("2026-10-06T08:00:00.000Z", "Europe/London", now)).toBe("Tue 6 Oct, 09:00");
    expect(formatScheduledInstant("2026-10-06T08:00:00.000Z", "Asia/Tokyo", now)).toBe("Tue 6 Oct, 17:00");
    expect(formatScheduledInstant("2027-01-05T09:00:00.000Z", "UTC", now)).toBe("Tue 5 Jan 2027, 09:00");
  });

  it("names the zone only when it differs from the viewer's", () => {
    const schedule = { kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] } as const;
    expect(scheduledTaskScheduleText({ ...schedule, days: [...schedule.days] }, "Europe/London", "Europe/London")).toBe("Every weekday at 09:00");
    expect(scheduledTaskScheduleText({ ...schedule, days: [...schedule.days] }, "America/New_York", "Europe/London"))
      .toBe("Every weekday at 09:00 · America/New York");
  });

  it("states next run, running, paused with a recovery hint and completed without raw codes", () => {
    expect(scheduledTaskStatusLine(scheduledTaskFixture(), now)).toEqual({ text: "Next run Tue 6 Oct, 09:00", tone: "neutral" });
    expect(scheduledTaskStatusLine(scheduledTaskFixture({ running: true }), now).text).toBe("Running now");
    expect(scheduledTaskStatusLine(scheduledTaskFixture({ status: "paused", nextRunAt: null }), now).text).toBe("Paused");
    expect(scheduledTaskStatusLine(scheduledTaskFixture({ status: "paused", nextRunAt: null, pauseReason: "model_unavailable" }), now))
      .toEqual({ text: "Paused: the model is no longer available. Edit to choose another model.", tone: "attention" });
    const unknown = scheduledTaskStatusLine(scheduledTaskFixture({ status: "paused", nextRunAt: null, pauseReason: "quota_exhausted_v2" }), now);
    expect(unknown.text).toBe("Paused: it could not run. Edit or resume to try again.");
    expect(unknown.text).not.toContain("quota");
    expect(scheduledTaskStatusLine(scheduledTaskFixture({ status: "completed", nextRunAt: null }), now).text).toBe("Completed");
  });

  it("describes the last run's outcome in words", () => {
    const run = (state: "completed" | "failed" | "skipped", reasonCode: string | null) => scheduledTaskLastRunLine(scheduledTaskFixture({
      lastRun: { scheduledFor: "2026-10-05T08:00:00.000Z", state, reasonCode, finishedAt: "2026-10-05T08:01:00.000Z", unseen: false }
    }), now);
    expect(scheduledTaskLastRunLine(scheduledTaskFixture(), now)).toBeNull();
    expect(run("completed", null)).toBe("Last run Mon 5 Oct, 09:00 · Answered");
    expect(run("failed", "chat_busy")).toBe("Last run Mon 5 Oct, 09:00 · Failed: the task's chat was busy with another answer");
    expect(run("skipped", "missed")).toBe("Last run Mon 5 Oct, 09:00 · Skipped: the scheduled time passed while runs were unavailable");
    expect(run("failed", "provider_http_529")).toBe("Last run Mon 5 Oct, 09:00 · Failed: the answer did not complete");
    // Every reason the runner records reads as words.
    expect(run("failed", "model_run_cancelled")).toBe("Last run Mon 5 Oct, 09:00 · Failed: it was stopped in the chat");
    expect(run("failed", "admission_failed")).toBe("Last run Mon 5 Oct, 09:00 · Failed: the run could not start");
    expect(run("skipped", "paused")).toBe("Last run Mon 5 Oct, 09:00 · Skipped: the task was paused");
  });

  it("announces answers and failures that paused the task, never routine skips or failures", () => {
    const notice = (state: "completed" | "failed" | "skipped", reasonCode: string | null, chatId: string | null = "chat-1",
      paused = false) => scheduledTaskResultNotice(scheduledTaskFixture({ chatId, unseenResult: true,
      ...(paused ? { status: "paused", nextRunAt: null, pauseReason: "repeated_failures" } : {}),
      lastRun: { scheduledFor: "2026-10-05T08:00:00.000Z", state, reasonCode, finishedAt: "2026-10-05T08:01:00.000Z", unseen: true } }));
    expect(notice("completed", null)).toEqual({ kind: "success", open: "chat", text: "“Weekday news brief” has a new result" });
    expect(notice("completed", null, null)).toMatchObject({ open: "scheduled" });
    expect(notice("failed", "run_failed", "chat-1", true)).toEqual({ kind: "error", open: "scheduled", text: "“Weekday news brief” could not run" });
    expect(notice("failed", "admission_failed")).toBeNull();
    for (const reason of ["missed", "previous_running", "superseded", "chat_busy", "paused"]) expect(notice("skipped", reason)).toBeNull();
    expect(scheduledTaskResultNotice(scheduledTaskFixture())).toBeNull();
  });

  it("explains overlap skips in the run history", () => {
    const row = (reasonCode: string) => scheduledTaskRunRow({ id: "run-1", scheduledFor: "2026-10-05T08:00:00.000Z",
      trigger: "schedule", state: "skipped", reasonCode, startedAt: null, finishedAt: "2026-10-05T08:00:01.000Z",
      chatId: null, unseen: false, unavailableSources: [] }, "Europe/London", now).outcome;
    expect(row("previous_running")).toBe("Skipped: the previous run was still in progress");
    expect(row("superseded")).toBe("Skipped: a newer scheduled time arrived before it could start");
  });

  it("summarizes hourly schedules", () => {
    expect(scheduledTaskScheduleText({ kind: "hourly", everyHours: 1, time: "00:00", until: null,
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, "Europe/London", "Europe/London")).toBe("Every hour");
    expect(scheduledTaskScheduleText({ kind: "hourly", everyHours: 3, time: "08:00", until: "20:00",
      days: ["sat", "sun"] }, "Europe/Berlin", "Europe/London")).toBe("Every 3 hours, 08:00–20:00, Sat, Sun · Europe/Berlin");
  });

  it("gives every runner pause reason a recovery hint", () => {
    const paused = (pauseReason: string) =>
      scheduledTaskStatusLine(scheduledTaskFixture({ status: "paused", nextRunAt: null, pauseReason }), now).text;
    expect(paused("provider_unavailable")).toBe("Paused: the model's provider is unavailable. Check the model, then resume.");
    expect(paused("account_inactive")).toBe("Paused: the account was not active. Resume to continue.");
    expect(paused("schedule_invalid")).toBe("Paused: its schedule can no longer be calculated. Edit the schedule.");
    expect(paused("repeated_failures")).toBe("Paused: the last three runs failed. Resume to try again.");
  });

  it("names a failed run's provider HTTP failure class apart from the provider pause reason", () => {
    const reasons = ["provider_auth_rejected", "provider_quota_exhausted", "provider_rate_limited", "provider_server_error"]
      .map((code) => scheduledTaskRunReasonText("failed", code));
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).not.toContain(scheduledTaskRunReasonText("failed", "provider_unavailable"));
    expect(reasons).not.toContain(scheduledTaskRunReasonText("failed", "something_new"));
  });

  it("maps the run conflict and unknown failures to copy", () => {
    expect(scheduledTaskFailureMessage("scheduled_task_running")).toMatch(/already running/u);
    expect(scheduledTaskFailureMessage("something_new")).toBe("Scheduled tasks are unavailable right now. Try again.");
  });

  it("orders active, paused, then completed tasks and lists the viewer's zone first", () => {
    const ids = sortScheduledTasks([
      scheduledTaskFixture({ id: "done", status: "completed", nextRunAt: null }),
      scheduledTaskFixture({ id: "paused", status: "paused", nextRunAt: null }),
      scheduledTaskFixture({ id: "active" })
    ]).map((task) => task.id);
    expect(ids).toEqual(["active", "paused", "done"]);
    const zones = scheduledTaskTimeZoneOptions("Europe/Berlin", "Antarctica/Troll");
    expect(zones.slice(0, 2)).toEqual(["Europe/Berlin", "Antarctica/Troll"]);
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe("scheduled task drafts", () => {
  it("maps Monday to Friday to the Weekdays preset and back", () => {
    const draft = scheduledTaskDraftFromTask(scheduledTaskFixture(), now);
    expect(draft.repeat).toBe("weekdays");
    expect(scheduledTaskDraftSchedule(draft)).toEqual({ kind: "weekly", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] });
    expect(scheduledTaskDraftSchedule({ ...draft, repeat: "weekly", days: ["fri", "mon"] }))
      .toEqual({ kind: "weekly", time: "09:00", days: ["mon", "fri"] });
  });

  it("starts new tasks daily at 09:00 with the catalog default model", () => {
    const draft = blankScheduledTaskDraft(catalog, "Europe/London", now);
    expect(draft).toMatchObject({ repeat: "daily", time: "09:00", modelId: "model-a", provider: "provider-a", date: "2026-10-05" });
  });

  it("validates names, days, past once times and Search before saving", () => {
    const base = blankScheduledTaskDraft(catalog, "Europe/London", now, { title: "Brief", prompt: "Do it" });
    expect(validateScheduledTaskDraft(base, catalog, null, now)).toEqual({});
    expect(validateScheduledTaskDraft({ ...base, title: "  ", prompt: "" }, catalog, null, now))
      .toMatchObject({ title: "Enter a name.", prompt: "Enter the instructions." });
    expect(validateScheduledTaskDraft({ ...base, repeat: "weekly", days: [] }, catalog, null, now).schedule).toBe("Choose at least one day.");
    expect(validateScheduledTaskDraft({ ...base, repeat: "once", date: "2026-10-04", time: "11:00" }, catalog, null, now).schedule)
      .toBe("Choose a time at least a minute from now.");
    expect(validateScheduledTaskDraft({ ...base, modelId: "model-b", searchEnabled: true }, catalog, null, now).search)
      .toMatch(/not available with this model/u);
    expect(validateScheduledTaskDraft({ ...base, modelId: "gone" }, catalog, null, now).model).toBe("Choose a model.");
  });

  it("sends only changed fields with the expected revision", () => {
    const task = scheduledTaskFixture({ revision: 4 });
    const draft = scheduledTaskDraftFromTask(task, now);
    expect(scheduledTaskUpdateRequest(draft, task)).toEqual({ expectedRevision: 4 });
    expect(scheduledTaskUpdateRequest({ ...draft, title: " New name ", repeat: "daily" }, task))
      .toEqual({ expectedRevision: 4, title: "New name", schedule: { kind: "daily", time: "09:00" } });
  });

  it("sends unchanged instructions whose links runs cannot read yet, so saving allows them", () => {
    const task = scheduledTaskFixture({ revision: 4, prompt: "Summarize https://news.example/today", promptLinksPending: true });
    const draft = scheduledTaskDraftFromTask(task, now);
    expect(scheduledTaskUpdateRequest(draft, task)).toEqual({ expectedRevision: 4, prompt: task.prompt });
    expect(scheduledTaskUpdateRequest({ ...draft, title: "Renamed" }, task))
      .toEqual({ expectedRevision: 4, title: "Renamed", prompt: task.prompt });
  });

  it("previews the next run, keeping an active task's due run when the schedule is unchanged", () => {
    const task = scheduledTaskFixture({ nextRunAt: "2026-10-05T08:00:00.000Z" });
    const draft = scheduledTaskDraftFromTask(task, now);
    expect(scheduledTaskPreview(draft, task, now)).toBe("Next run: Mon 5 Oct, 09:00");
    expect(scheduledTaskPreview({ ...draft, repeat: "daily", time: "12:00" }, task, now)).toBe("Next run: Sun 4 Oct, 12:00");
    expect(scheduledTaskPreview({ ...draft, repeat: "weekly", days: [] }, task, now)).toBe("Choose at least one day to see the next run.");
    const paused = scheduledTaskFixture({ status: "paused", nextRunAt: null });
    expect(scheduledTaskPreview(scheduledTaskDraftFromTask(paused, now), paused, now)).toBe("Paused. After you resume, it runs next Mon 5 Oct, 09:00.");
  });

  it("maps hourly schedules to the window controls and back without changing them", () => {
    const weekdays = ["mon", "tue", "wed", "thu", "fri"] as const;
    const cases = [
      { kind: "hourly", everyHours: 1, time: "00:00", until: null, days: [...weekdays] },
      { kind: "hourly", everyHours: 2, time: "09:00", until: "18:00", days: [...weekdays] },
      { kind: "hourly", everyHours: 4, time: "06:00", until: null, days: ["sat"] },
      { kind: "hourly", everyHours: 12, time: "00:00", until: "12:00", days: ["sun"] }
    ] as const;
    for (const schedule of cases) {
      const task = scheduledTaskFixture({ schedule: { ...schedule, days: [...schedule.days] } });
      const draft = scheduledTaskDraftFromTask(task, now);
      expect(draft.repeat).toBe("hourly");
      expect(scheduledTaskDraftSchedule(draft)).toEqual(schedule);
      expect(scheduledTaskUpdateRequest(draft, task)).toEqual({ expectedRevision: 1 });
    }
    const allDay = scheduledTaskDraftFromTask(scheduledTaskFixture({ schedule: { ...cases[0], days: [...weekdays] } }), now);
    expect(allDay).toMatchObject({ hourlyWindow: "all_day", time: "09:00", until: "18:00" });
    expect(scheduledTaskDraftFromTask(scheduledTaskFixture({ schedule: { ...cases[2], days: ["sat"] } }), now))
      .toMatchObject({ hourlyWindow: "hours", time: "06:00", until: "" });
  });

  it("validates an hourly window in the decoder's terms and previews its next run", () => {
    const base = blankScheduledTaskDraft(catalog, "Europe/London", now, { title: "Inbox", prompt: "Check", repeat: "hourly" });
    expect(validateScheduledTaskDraft(base, catalog, null, now)).toEqual({});
    expect(scheduledTaskPreview(base, null, now)).toBe("Next run: Sun 4 Oct, 12:00");
    const window = { ...base, hourlyWindow: "hours" as const, time: "09:00", until: "18:00", everyHours: 3 as const };
    expect(scheduledTaskPreview({ ...window, hourlyDays: ["mon"] }, null, now)).toBe("Next run: Mon 5 Oct, 09:00");
    expect(validateScheduledTaskDraft({ ...window, until: "09:00" }, catalog, null, now).schedule)
      .toBe("Choose an end time later than the start time.");
    expect(validateScheduledTaskDraft({ ...window, time: "" }, catalog, null, now).schedule).toBe("Enter a start time.");
    expect(validateScheduledTaskDraft({ ...window, hourlyDays: [] }, catalog, null, now).schedule).toBe("Choose at least one day.");
    expect(scheduledTaskPreview({ ...window, hourlyDays: [] }, null, now)).toBe("Choose at least one day to see the next run.");
    expect(scheduledTaskDraftSchedule({ ...window, until: "" })).toMatchObject({ time: "09:00", until: null });
  });

  it("starts new tasks in a new chat per run and switches to the same chat only for hourly schedules", () => {
    const draft = blankScheduledTaskDraft(catalog, "Europe/London", now, { title: "Brief", prompt: "Do it" });
    expect(draft.chatMode).toBe("new");
    expect(scheduledTaskCreateRequest(draft)?.chatMode).toBe("new");
    expect(scheduledTaskCreateRequest({ ...draft, repeat: "hourly" })?.chatMode).toBe("same");
    const daily = scheduledTaskFixture({ chatMode: "new", schedule: { kind: "daily", time: "09:00" } });
    const edit = scheduledTaskDraftFromTask(daily, now);
    expect(scheduledTaskUpdateRequest({ ...edit, repeat: "hourly" }, daily)).toMatchObject({ chatMode: "same", schedule: { kind: "hourly" } });
    // The draft keeps the owner's choice, so leaving hourly again sends no chat change.
    expect(scheduledTaskUpdateRequest({ ...edit, repeat: "daily" }, daily)).toEqual({ expectedRevision: 1 });
    const same = scheduledTaskFixture({ chatMode: "same", schedule: { kind: "daily", time: "09:00" } });
    expect(scheduledTaskUpdateRequest({ ...scheduledTaskDraftFromTask(same, now), repeat: "hourly" }, same)).not.toHaveProperty("chatMode");
  });
});

describe("monitoring and tool copy", () => {
  const run = (overrides: Partial<ScheduledTaskRun>): ScheduledTaskRun => ({
    id: "run-1", scheduledFor: "2026-10-05T08:00:00.000Z", trigger: "schedule", state: "completed", reasonCode: null,
    startedAt: "2026-10-05T08:00:01.000Z", finishedAt: "2026-10-05T08:01:00.000Z", chatId: "chat-1", unseen: false,
    unavailableSources: [], ...overrides
  });

  it("gives check outcomes their copy, keeps no-update rows quiet and lists unavailable sources in attention tone", () => {
    const row = (overrides: Partial<ScheduledTaskRun>) => scheduledTaskRunRow(run(overrides), "Europe/London", now);
    expect(row({ reasonCode: "no_update" })).toMatchObject({ outcome: "No update: nothing changed since the last shown result", tone: "quiet", sources: [] });
    expect(row({ reasonCode: "update" })).toMatchObject({ outcome: "Update: something changed since the last shown result", tone: "neutral" });
    expect(row({ reasonCode: "baseline" }).outcome).toBe("First check: the starting point later checks compare with");
    expect(row({ reasonCode: "goal_reached" })).toMatchObject({ outcome: "Goal reached — task completed", tone: "neutral" });
    expect(row({ reasonCode: "unreported" }).outcome).toBe("Shown: the check did not report whether anything changed");
    expect(row({ reasonCode: "could_not_check", unavailableSources: [{ name: "Tracker", reason: "mcp_reauthorization_required" }] }))
      .toEqual(expect.objectContaining({ outcome: "Could not check: a source was unavailable", tone: "attention", sources: ["Tracker needs sign-in."] }));
    // A regular run that went ahead without a source still answered; its sources show in attention tone.
    expect(row({ unavailableSources: [{ name: "Calendar", reason: "mcp_server_unavailable" }] }))
      .toEqual(expect.objectContaining({ outcome: "Answered", tone: "attention", sources: ["Calendar is unavailable."] }));
    expect(row({ state: "failed", reasonCode: "run_deadline" }).outcome).toBe("Failed: it was stopped after running for 30 minutes");
    expect(row({ state: "failed", reasonCode: "tools_unavailable" }).outcome).toBe("Failed: the task's tools could not be used with this model");
  });

  it("names a monitoring check's outcome on the last-run line and a reached goal on the status line", () => {
    const last = (reasonCode: string) => scheduledTaskLastRunLine(scheduledTaskFixture({ kind: "monitoring",
      lastRun: { scheduledFor: "2026-10-05T08:00:00.000Z", state: "completed", reasonCode, finishedAt: "2026-10-05T08:01:00.000Z", unseen: false } }), now);
    expect(last("no_update")).toBe("Last run Mon 5 Oct, 09:00 · No update");
    expect(last("could_not_check")).toBe("Last run Mon 5 Oct, 09:00 · Could not check");
    expect(scheduledTaskStatusLine(scheduledTaskFixture({ status: "completed", nextRunAt: null, completionReason: "goal_reached" }), now))
      .toEqual({ text: "Goal reached — completed", tone: "neutral" });
  });

  it("gives the tool and monitoring pause reasons a recovery hint", () => {
    const paused = (pauseReason: string) =>
      scheduledTaskStatusLine(scheduledTaskFixture({ status: "paused", nextRunAt: null, pauseReason }), now).text;
    expect(paused("model_cannot_report")).toBe("Paused: monitoring needs a model that can use tools. Edit to choose another model.");
    expect(paused("verdict_missing")).toBe("Paused: three checks in a row did not report whether anything changed. Resume to try again.");
    expect(paused("source_unavailable")).toBe("Paused: 3 runs in a row could not reach a source it uses. Reconnect the source, then resume.");
    expect(paused("tools_unavailable")).toMatch(/^Paused: its tools can no longer be used/u);
    expect(paused("workspace_unavailable")).toMatch(/^Paused: Workspace can no longer be used/u);
    expect(paused("workspace_secret_limit")).toMatch(/^Paused: your saved Workspace secrets exceed the limit/u);
  });

  it("announces a reached goal, a source alert and a pause by a completed check, never a check with no update", () => {
    const notice = (reasonCode: string | null, task: Partial<ScheduledTask> = {}) => scheduledTaskResultNotice(scheduledTaskFixture({
      chatId: "chat-1", unseenResult: true, kind: "monitoring", ...task,
      lastRun: { scheduledFor: "2026-10-05T08:00:00.000Z", state: "completed", reasonCode, finishedAt: "2026-10-05T08:01:00.000Z", unseen: true } }));
    expect(notice("goal_reached", { status: "completed", nextRunAt: null, completionReason: "goal_reached" }))
      .toEqual({ kind: "success", open: "chat", text: "“Weekday news brief” reached its goal" });
    expect(notice("update")).toEqual({ kind: "success", open: "chat", text: "“Weekday news brief” has a new result" });
    expect(notice("no_update")).toBeNull();
    expect(notice("could_not_check")).toEqual({ kind: "error", open: "scheduled", text: "“Weekday news brief” could not check a source" });
    expect(notice("unreported", { status: "paused", nextRunAt: null, pauseReason: "verdict_missing" }))
      .toEqual({ kind: "error", open: "scheduled", text: "“Weekday news brief” was paused" });
  });
});

describe("scheduled task type and tools in drafts", () => {
  const base = blankScheduledTaskDraft(catalog, "Europe/London", now, { title: "Watch", prompt: "Tell me when it ships." });

  it("starts the switches from the composer defaults, off for a model without tools or Workspace turned off", () => {
    expect(base).toMatchObject({ toolsEnabled: true, workspaceEnabled: false, kind: "standard" });
    const defaults = { ...catalog, defaults: { ...catalog.defaults, mcpMode: "off" as const, workspaceEnabled: true } };
    expect(blankScheduledTaskDraft(defaults, "Europe/London", now)).toMatchObject({ toolsEnabled: false, workspaceEnabled: true });
    expect(blankScheduledTaskDraft(defaults, "Europe/London", now, {}, "installation_disabled")).toMatchObject({ workspaceEnabled: false });
    expect(scheduledTaskStartingTools(defaults, { modelId: "model-c", provider: "provider-a" }))
      .toEqual({ toolsEnabled: false, workspaceEnabled: false });
  });

  it("continues monitoring in one chat and restores the owner's choice when it leaves monitoring", () => {
    expect(scheduledTaskForcedChatReason(base)).toBeNull();
    expect(scheduledTaskForcedChatReason({ ...base, kind: "monitoring" })).toMatch(/always continues in one chat/u);
    expect(scheduledTaskCreateRequest({ ...base, kind: "monitoring" })).toMatchObject({ chatMode: "same", kind: "monitoring" });
    const daily = scheduledTaskFixture({ chatMode: "new", schedule: { kind: "daily", time: "09:00" } });
    const edit = scheduledTaskDraftFromTask(daily, now);
    expect(scheduledTaskUpdateRequest({ ...edit, kind: "monitoring" }, daily))
      .toEqual({ expectedRevision: 1, chatMode: "same", kind: "monitoring" });
    expect(scheduledTaskUpdateRequest({ ...edit, kind: "standard" }, daily)).toEqual({ expectedRevision: 1 });
  });

  it("explains and blocks what the model or installation cannot do, as the server refuses it", () => {
    const noTools = { ...base, modelId: "model-c" };
    expect(scheduledTaskCapabilityBlockers(catalog, base, "available")).toEqual({ monitoring: null, tools: null, workspace: null });
    expect(scheduledTaskCapabilityBlockers(catalog, base, "runtime_unavailable").workspace).toBeNull();
    expect(scheduledTaskCapabilityBlockers(catalog, base, "installation_disabled").workspace)
      .toBe("Workspace is turned off by the administrator.");
    expect(scheduledTaskCapabilityBlockers(catalog, noTools, "available"))
      .toEqual({ monitoring: "Monitoring needs a model that can use tools. Choose another model.",
        tools: "Not available with this model.", workspace: "Not available with this model." });
    expect(validateScheduledTaskDraft({ ...noTools, toolsEnabled: false }, catalog, null, now)).toEqual({});
    expect(validateScheduledTaskDraft({ ...noTools, kind: "monitoring", toolsEnabled: true, workspaceEnabled: true }, catalog, null, now))
      .toEqual({
        kind: "Monitoring needs a model that can use tools. Choose another model.",
        tools: "This model cannot use tools. Turn tools off or choose another model.",
        workspace: expect.stringMatching(/^Workspace is not available for this task/u)
      });
    expect(validateScheduledTaskDraft({ ...base, workspaceEnabled: true }, catalog, null, now, "installation_disabled").workspace)
      .toMatch(/^Workspace is not available for this task/u);
  });

  it("reads the installation's Workspace availability apart from the composer model's", () => {
    expect(scheduledTaskWorkspaceAvailability({ available: false, loading: true })).toBe("unknown");
    expect(scheduledTaskWorkspaceAvailability({ available: true, loading: false })).toBe("available");
    expect(scheduledTaskWorkspaceAvailability({ available: false, loading: false, unavailableReason: "model_tools_required" })).toBe("available");
    expect(scheduledTaskWorkspaceAvailability({ available: false, loading: false, unavailableReason: "installation_disabled" }))
      .toBe("installation_disabled");
  });
});

describe("scheduled task Memory in drafts", () => {
  it("starts a new task reading Memory, keeps a stored task's choice and sends only a change", () => {
    const blank = blankScheduledTaskDraft(catalog, "Europe/London", now, { title: "Brief", prompt: "Summarize." });
    expect(blank.memoryEnabled).toBe(true);
    expect(scheduledTaskCreateRequest(blank)).toMatchObject({ memoryEnabled: true });
    expect(blankScheduledTaskDraft(null, "Europe/London", now).memoryEnabled).toBe(true);
    const stored = scheduledTaskFixture({ memoryEnabled: false });
    const edit = scheduledTaskDraftFromTask(stored, now);
    expect(edit.memoryEnabled).toBe(false);
    expect(sameScheduledTaskDraft(edit, { ...edit, memoryEnabled: true })).toBe(false);
    expect(scheduledTaskUpdateRequest(edit, stored)).toEqual({ expectedRevision: 1 });
    expect(scheduledTaskUpdateRequest({ ...edit, memoryEnabled: true }, stored)).toEqual({ expectedRevision: 1, memoryEnabled: true });
    // Memory needs no tool calling: a model without tools keeps the switch and saves.
    expect(validateScheduledTaskDraft({ ...blank, modelId: "model-c", toolsEnabled: false, workspaceEnabled: false }, catalog, null, now))
      .toEqual({});
  });

  it("reads the owner's Memory state from the shell's settings", () => {
    expect(scheduledTaskMemoryAvailability(null)).toBe("unknown");
    expect(scheduledTaskMemoryAvailability({ status: "PAUSED" })).toBe("paused");
    expect(scheduledTaskMemoryAvailability({ status: "NEEDS_ADMIN_SETUP" })).toBe("needs_setup");
    for (const status of ["ON", "PREPARING", "UNAVAILABLE"] as const) {
      expect(scheduledTaskMemoryAvailability({ status })).toBe("available");
    }
  });
});
