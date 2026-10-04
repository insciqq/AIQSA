import { describe, expect, it } from "vitest";
import {
  blankScheduledTaskDraft,
  scheduledTaskDraftFromTask,
  scheduledTaskDraftSchedule,
  scheduledTaskPreview,
  scheduledTaskUpdateRequest,
  validateScheduledTaskDraft
} from "./scheduledTaskDraft";
import { scheduledTaskCatalogFixture, scheduledTaskFixture } from "./scheduledTaskFixtures";
import {
  formatScheduledInstant,
  scheduledTaskFailureMessage,
  scheduledTaskLastRunLine,
  scheduledTaskResultNotice,
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
      lastRun: { scheduledFor: "2026-10-05T08:00:00.000Z", state, reasonCode, finishedAt: "2026-10-05T08:01:00.000Z" }
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

  it("announces what a settled run did and never the owner's own pause", () => {
    const notice = (state: "completed" | "failed" | "skipped", reasonCode: string | null, chatId: string | null = "chat-1") =>
      scheduledTaskResultNotice(scheduledTaskFixture({ chatId, unseenResult: true,
        lastRun: { scheduledFor: "2026-10-05T08:00:00.000Z", state, reasonCode, finishedAt: "2026-10-05T08:01:00.000Z" } }));
    expect(notice("completed", null)).toEqual({ kind: "success", open: "chat", text: "“Weekday news brief” has a new result" });
    expect(notice("completed", null, null)).toMatchObject({ open: "scheduled" });
    expect(notice("failed", "admission_failed")).toEqual({ kind: "error", open: "scheduled", text: "“Weekday news brief” could not run" });
    expect(notice("skipped", "missed")).toEqual({ kind: "success", open: "scheduled", text: "“Weekday news brief” was skipped" });
    expect(notice("skipped", "paused")).toBeNull();
    expect(scheduledTaskResultNotice(scheduledTaskFixture())).toBeNull();
  });

  it("gives every runner pause reason a recovery hint", () => {
    const paused = (pauseReason: string) =>
      scheduledTaskStatusLine(scheduledTaskFixture({ status: "paused", nextRunAt: null, pauseReason }), now).text;
    expect(paused("provider_unavailable")).toBe("Paused: the model's provider is unavailable. Check the model, then resume.");
    expect(paused("account_inactive")).toBe("Paused: the account was not active. Resume to continue.");
    expect(paused("schedule_invalid")).toBe("Paused: its schedule can no longer be calculated. Edit the schedule.");
    expect(paused("repeated_failures")).toBe("Paused: the last three runs failed. Resume to try again.");
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

  it("previews the next run, keeping an active task's due run when the schedule is unchanged", () => {
    const task = scheduledTaskFixture({ nextRunAt: "2026-10-05T08:00:00.000Z" });
    const draft = scheduledTaskDraftFromTask(task, now);
    expect(scheduledTaskPreview(draft, task, now)).toBe("Next run: Mon 5 Oct, 09:00");
    expect(scheduledTaskPreview({ ...draft, repeat: "daily", time: "12:00" }, task, now)).toBe("Next run: Sun 4 Oct, 12:00");
    expect(scheduledTaskPreview({ ...draft, repeat: "weekly", days: [] }, task, now)).toBe("Choose at least one day to see the next run.");
    const paused = scheduledTaskFixture({ status: "paused", nextRunAt: null });
    expect(scheduledTaskPreview(scheduledTaskDraftFromTask(paused, now), paused, now)).toBe("Paused. After you resume, it runs next Mon 5 Oct, 09:00.");
  });
});
