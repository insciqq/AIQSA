import {
  SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD,
  SCHEDULED_TASK_RUN_DEADLINE_MINUTES,
  SCHEDULED_TASK_WEEKDAYS,
  SCHEDULED_TASK_WORKSPACE_WAIT_CODE,
  isScheduledTaskCheckOutcome,
  isScheduledTaskRunIncomplete,
  scheduledTaskErrorMessage,
  scheduledTaskReasonMessage,
  scheduledTaskSkillUnavailableReason,
  scheduledTaskSourceMessage,
  type ScheduledTask,
  type ScheduledTaskCheckOutcome,
  type ScheduledTaskHistoryRetentionDays,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type ScheduledTaskWeekday
} from "@/lib/contracts/scheduledTasks";
import { describeScheduledTaskSchedule, validScheduledTaskTimeZone } from "@/lib/domain/scheduledTaskSchedule";

/**
 * English copy and formatting for scheduled tasks. Every stable code maps to
 * a human sentence with a recovery hint; unknown codes get a generic line and
 * are never shown raw.
 */

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const instantFormatters = new Map<string, Intl.DateTimeFormat>();

function instantParts(date: Date, timeZone: string): Record<string, string> {
  let formatter = instantFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "numeric", timeZone, weekday: "short",
      year: "numeric"
    });
    instantFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) if (part.type !== "literal") parts[part.type] = part.value;
  return parts;
}

/** "Tue 6 Oct, 09:00" in the task's zone; the year appears only when it is not the current one. */
export function formatScheduledInstant(value: string | Date, timeZone: string, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "an unknown time";
  const zone = validScheduledTaskTimeZone(timeZone) ?? "UTC";
  const parts = instantParts(date, zone);
  return `${dayLabel(parts, zone, now)}, ${parts.hour}:${parts.minute}`;
}

function dayLabel(parts: Record<string, string>, zone: string, now: Date): string {
  const year = parts.year !== instantParts(now, zone).year ? ` ${parts.year}` : "";
  return `${parts.weekday} ${Number(parts.day)} ${MONTH_LABELS[Number(parts.month) - 1] ?? parts.month}${year}`;
}

/** "Tue 6 Oct" in the task's zone, with the year only when it is not the current one. */
export function formatScheduledDay(value: string | Date, timeZone: string, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "an unknown day";
  const zone = validScheduledTaskTimeZone(timeZone) ?? "UTC";
  return dayLabel(instantParts(date, zone), zone, now);
}

/** The browser's IANA zone, or UTC when the runtime reports none it can resolve. */
export function browserTimeZone(): string {
  try {
    return validScheduledTaskTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone the runtime knows, with the browser zone (and an unknown saved one) first. */
export function scheduledTaskTimeZoneOptions(browserZone: string, current?: string): string[] {
  let zones: string[] = [];
  try {
    zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    zones = [];
  }
  const first = [browserZone, ...(current && current !== browserZone ? [current] : [])];
  return [...first, ...zones.filter((zone) => !first.includes(zone)), ...(zones.includes("UTC") || first.includes("UTC") ? [] : ["UTC"])];
}

export function timeZoneLabel(zone: string): string {
  return zone.replaceAll("_", " ");
}

/** The shared schedule summary, plus the zone when it differs from the viewer's. */
export function scheduledTaskScheduleText(schedule: ScheduledTaskSchedule, timeZone: string, viewerZone: string): string {
  const summary = describeScheduledTaskSchedule(schedule);
  return timeZone === viewerZone ? summary : `${summary} · ${timeZoneLabel(timeZone)}`;
}

type PauseCopy = Readonly<{ reason: string; hint: string }>;

/**
 * Why a task paused itself and how to recover. A lost pinned Skill is named
 * when the task's projection still lets the owner see it.
 */
export function scheduledTaskPauseCopy(reasonCode: string, task?: Pick<ScheduledTask, "pinnedSkills">): PauseCopy {
  switch (reasonCode) {
    case "skill_unavailable":
      return { reason: scheduledTaskSkillUnavailableReason(task ?? {}), hint: "Edit the task's Skills, then resume." };
    case "model_unavailable":
      return { reason: "the model is no longer available", hint: "Edit to choose another model." };
    case "search_unavailable":
      return { reason: "web search is no longer available with this model", hint: "Edit to turn it off or choose another model." };
    case "provider_unavailable":
      return { reason: "the model's provider is unavailable", hint: "Check the model, then resume." };
    case "account_inactive":
      return { reason: "the account was not active", hint: "Resume to continue." };
    case "schedule_invalid":
      return { reason: "its schedule can no longer be calculated", hint: "Edit the schedule." };
    case "repeated_failures":
      return { reason: "the last three runs failed", hint: "Resume to try again." };
    case "tools_unavailable":
      return { reason: "its tools can no longer be used with this model", hint: "Edit to turn tools off or choose another model." };
    case "workspace_unavailable":
      return { reason: "Workspace can no longer be used for it", hint: "Edit to turn Workspace off or choose a model with tool support." };
    case "workspace_secret_limit":
      return { reason: "your saved Workspace secrets exceed the limit", hint: "Remove some in Settings or turn Workspace off, then resume." };
    case "source_unavailable":
      return {
        reason: `${SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD} runs in a row could not reach a source it uses`,
        hint: "Reconnect the source, then resume."
      };
    case "model_cannot_report":
      return { reason: "monitoring needs a model that can use tools", hint: "Edit to choose another model." };
    case "verdict_missing":
      return { reason: "three checks in a row did not report whether anything changed", hint: "Resume to try again." };
    case "once_in_past":
    case "missed":
      return { reason: "its time has passed", hint: "Edit to choose a new time." };
    default:
      return { reason: "it could not run", hint: "Edit or resume to try again." };
  }
}

/** A failed or skipped run's reason, as a clause after "Failed:" or "Skipped:". */
export function scheduledTaskRunReasonText(state: "failed" | "skipped", reasonCode: string | null): string {
  switch (reasonCode) {
    case "missed": return "the scheduled time passed while runs were unavailable";
    case "chat_busy": return "the task's chat was busy with another answer";
    case "usage_budget_exhausted": return "your monthly budget was used up";
    case "installation_budget_exhausted": return "the monthly budget shared by everyone was used up";
    case "previous_running": return "the previous run was still in progress";
    case "superseded": return "a newer scheduled time arrived before it could start";
    case "workspace_capacity": return "no Workspace slot became free in time; other scheduled runs were using Workspace";
    case "model_unavailable": return "the model was unavailable";
    case "search_unavailable": return "web search was unavailable with this model";
    case "provider_unavailable": return "the model's provider was unavailable";
    case "provider_auth_rejected": return "the model provider rejected the configured key";
    case "provider_quota_exhausted": return "the model provider account had no remaining quota or balance";
    case "provider_rate_limited": return "the model provider was limiting requests";
    case "provider_server_error": return "the model provider returned a server error";
    case "account_inactive": return "the account was not active";
    case "schedule_invalid": return "the schedule could not be calculated";
    case "paused": return "the task was paused";
    case "admission_failed": return "the run could not start";
    case "run_unavailable": return "the run was removed before it finished";
    case "model_run_cancelled": return "it was stopped in the chat";
    case "repeated_failures": return "the task was paused after repeated failures";
    case "tools_unavailable": return "the task's tools could not be used with this model";
    case "workspace_unavailable": return "Workspace could not be used for this task";
    case "workspace_secret_limit": return "the saved Workspace secrets exceed the limit";
    case "source_unavailable": return "a source the task uses was unavailable";
    case "skill_unavailable": return "a pinned Skill was no longer available";
    case "workspace_carryover_unavailable":
      return "the Workspace files of the previous chat could not be carried over; the next run tries again, " +
        "or turn Workspace off for the task to go on without them";
    case "model_cannot_report": return "the model cannot report monitoring results";
    case "run_deadline": return `it was stopped after running for ${SCHEDULED_TASK_RUN_DEADLINE_MINUTES} minutes`;
    case "provider_error":
    case "run_failed": return "the model did not return an answer";
    default: return state === "failed" ? "the answer did not complete" : "the run was not started";
  }
}

/** A pending run waiting for a free scheduled Workspace slot, as a row and the status line say it. */
export const SCHEDULED_TASK_WORKSPACE_WAIT_TEXT = "Waiting for a free Workspace slot";

/** The editor's note on recurring schedules: a run starts shortly after the shown time (the dispatch spread). */
export const SCHEDULED_TASK_SPREAD_NOTE = "Starts within 3 minutes of the scheduled time.";

export type ScheduledTaskStatusLine = Readonly<{
  text: string;
  tone: "neutral" | "live" | "attention";
}>;

/**
 * The one status sentence a row shows: next run, running (or waiting for a
 * free Workspace slot), paused (with reason) or completed, and why when a
 * monitoring check reached its goal.
 */
export function scheduledTaskStatusLine(task: ScheduledTask, now: Date = new Date()): ScheduledTaskStatusLine {
  if (task.running) return { text: task.waitingForWorkspace ? SCHEDULED_TASK_WORKSPACE_WAIT_TEXT : "Running now", tone: "live" };
  if (task.status === "completed") {
    return { text: task.completionReason === "goal_reached" ? "Goal reached — completed" : "Completed", tone: "neutral" };
  }
  if (task.status === "paused") {
    if (!task.pauseReason) return { text: "Paused", tone: "neutral" };
    const copy = scheduledTaskPauseCopy(task.pauseReason, task);
    return { text: `Paused: ${copy.reason}. ${copy.hint}`, tone: "attention" };
  }
  return task.nextRunAt
    ? { text: `Next run ${formatScheduledInstant(task.nextRunAt, task.timeZone, now)}`, tone: "neutral" }
    : { text: "No upcoming run", tone: "neutral" };
}

/** Short labels of monitoring check outcomes, for the list's last-run line. */
const CHECK_OUTCOME_LABELS: Readonly<Record<ScheduledTaskCheckOutcome, string>> = {
  baseline: "First check",
  update: "Update",
  no_update: "No update",
  goal_reached: "Goal reached",
  unreported: "Answered without a report",
  could_not_check: "Could not check"
};

/** A sentence of the shared reason copy as a row clause, without its closing period. */
function clause(sentence: string): string {
  return sentence.endsWith(".") ? sentence.slice(0, -1) : sentence;
}

function outcomeText(state: ScheduledTaskRun["state"], reasonCode: string | null): string {
  switch (state) {
    case "completed": return isScheduledTaskCheckOutcome(reasonCode) ? CHECK_OUTCOME_LABELS[reasonCode] : "Answered";
    case "failed": return `Failed: ${scheduledTaskRunReasonText("failed", reasonCode)}`;
    case "skipped": return `Skipped: ${scheduledTaskRunReasonText("skipped", reasonCode)}`;
    case "running": return "Running";
    case "pending": return reasonCode === SCHEDULED_TASK_WORKSPACE_WAIT_CODE ? SCHEDULED_TASK_WORKSPACE_WAIT_TEXT : "Starting";
  }
}

/** "Last run Mon 5 Oct, 09:00 · Answered", or null before the first settled run. */
export function scheduledTaskLastRunLine(task: ScheduledTask, now: Date = new Date()): string | null {
  if (!task.lastRun) return null;
  return `Last run ${formatScheduledInstant(task.lastRun.scheduledFor, task.timeZone, now)} · ${outcomeText(task.lastRun.state, task.lastRun.reasonCode)}`;
}

export type ScheduledTaskResultNotice = Readonly<{
  kind: "error" | "success";
  /** Where the notice's action leads: the answer in the task's chat, or the task's runs in Studio › Scheduled. */
  open: "chat" | "scheduled";
  text: string;
}>;

/** Automatic pauses that a completed run causes: a streak missing a source, or checks without a report. */
const COMPLETED_RUN_PAUSES: ReadonlySet<string> = new Set(["source_unavailable", "verdict_missing"]);

function pausedAutomatically(task: ScheduledTask): boolean {
  return task.status === "paused" && task.pauseReason !== null;
}

/**
 * The notice for a newly settled run that the list found news, saying what
 * happened; null for a run that cannot be news (a check with no update, a
 * skip, a failure that did not pause the task).
 */
export function scheduledTaskResultNotice(task: ScheduledTask): ScheduledTaskResultNotice | null {
  const run = task.lastRun;
  if (!run) return null;
  const open = task.chatId ? "chat" : "scheduled";
  if (run.state === "completed") {
    if (pausedAutomatically(task) && COMPLETED_RUN_PAUSES.has(task.pauseReason ?? "")) {
      return { kind: "error", open: "scheduled", text: `“${task.title}” was paused` };
    }
    if (run.reasonCode === "could_not_check") return { kind: "error", open: "scheduled", text: `“${task.title}” could not check a source` };
    if (run.reasonCode === "goal_reached") return { kind: "success", open, text: `“${task.title}” reached its goal` };
    if (run.reasonCode === "no_update") return null;
    return { kind: "success", open, text: `“${task.title}” has a new result` };
  }
  return run.state === "failed" && pausedAutomatically(task)
    ? { kind: "error", open: "scheduled", text: `“${task.title}” could not run` }
    : null;
}

export type ScheduledTaskRunRow = Readonly<{
  outcome: string;
  /** One line per source the run could not reach. */
  sources: readonly string[];
  /** The pinned Skills the run loaded with the version each used, or null without any. */
  skills: string | null;
  time: string;
  /** `quiet`: a monitoring check with no update, history only. */
  tone: "neutral" | "attention" | "live" | "quiet";
  trigger: string;
}>;

function runTone(run: ScheduledTaskRun): ScheduledTaskRunRow["tone"] {
  if (run.state === "pending" || run.state === "running") return "live";
  if (run.state === "failed" || run.reasonCode === "could_not_check" || isScheduledTaskRunIncomplete(run)) return "attention";
  return run.state === "completed" && run.reasonCode === "no_update" ? "quiet" : "neutral";
}

/** One history row: a check's outcome in its full copy, and the sources an incomplete run could not reach. */
export function scheduledTaskRunRow(run: ScheduledTaskRun, timeZone: string, now: Date = new Date()): ScheduledTaskRunRow {
  const check = run.state === "completed" && isScheduledTaskCheckOutcome(run.reasonCode)
    ? scheduledTaskReasonMessage(run.reasonCode) : null;
  return {
    outcome: check ? clause(check) : outcomeText(run.state, run.reasonCode),
    sources: run.unavailableSources.map(scheduledTaskSourceMessage),
    skills: run.skills.length > 0
      ? `Skills: ${run.skills.map((skill) => `${skill.name} v${skill.version}`).join(", ")}` : null,

    time: formatScheduledInstant(run.startedAt ?? run.scheduledFor, timeZone, now),
    tone: runTone(run),
    trigger: run.trigger === "manual" ? "Run now" : "Scheduled"
  };
}

/** Where a run's answer appears, for the editor's chat-mode control and Run now notices. */
export const SCHEDULED_TASK_CHAT_MODE_LABELS: Readonly<Record<ScheduledTask["chatMode"], string>> = {
  new: "Each run starts a new chat",
  same: "Continue in this task's chat"
};

/** The history choices the editor offers, shortest first; null keeps old chats forever. */
export const SCHEDULED_TASK_HISTORY_OPTIONS: readonly Readonly<{ label: string; value: ScheduledTaskHistoryRetentionDays }>[] = [
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "1 year", value: 365 },
  { label: "Forever", value: null }
];

/** What the history retention never deletes, for the card and the editor. */
export const SCHEDULED_TASK_HISTORY_KEPT_TEXT =
  "The current chat is kept, and so is any chat you wrote in, pinned, put in a folder, shared, renamed or restored.";

function historyLabel(days: ScheduledTaskHistoryRetentionDays): string {
  return SCHEDULED_TASK_HISTORY_OPTIONS.find((option) => option.value === days)?.label ?? "Forever";
}

/**
 * The card's history line: how long old chats of the task are kept, when the
 * next one goes as things stand, and how many went (a count only).
 */
export function scheduledTaskHistoryLine(task: Pick<ScheduledTask, "historyDeletedChats" | "historyNextDeletionAt" |
  "historyRetentionDays" | "timeZone">, now: Date = new Date()): string {
  const parts = [task.historyRetentionDays === null ? "History: kept forever" : `History: ${historyLabel(task.historyRetentionDays)}`];
  if (task.historyRetentionDays !== null && task.historyNextDeletionAt) {
    const due = new Date(task.historyNextDeletionAt);
    parts.push(due.getTime() <= now.getTime() ? "next cleanup soon"
      : `next cleanup ${formatScheduledDay(due, task.timeZone, now)}`);
  }
  if (task.historyDeletedChats > 0) {
    parts.push(`${task.historyDeletedChats} old ${task.historyDeletedChats === 1 ? "chat" : "chats"} deleted`);
  }
  return parts.join(" · ");
}

/** Copy for API failures, including codes the shared contract does not name. */
export function scheduledTaskFailureMessage(code: string | null): string {
  switch (code) {
    case "scheduled_task_running": return "This task is already running. Its answer will appear in the task's chat.";
    case "unauthorized": return "Your session has ended. Sign in again to manage scheduled tasks.";
    case "forbidden": return "Your account cannot manage scheduled tasks.";
    case "payload_too_large":
    case "request_body_too_large": return "The instructions are too long.";
    default: return scheduledTaskErrorMessage(code);
  }
}

/** Active first, then paused, then completed; the server's newest-first order within each. */
export function sortScheduledTasks(tasks: readonly ScheduledTask[]): ScheduledTask[] {
  const rank = { active: 0, paused: 1, completed: 2 } as const;
  return tasks.map((task, index) => ({ index, task }))
    .sort((left, right) => rank[left.task.status] - rank[right.task.status] || left.index - right.index)
    .map(({ task }) => task);
}

export const WEEKDAY_SHORT_LABELS: Record<ScheduledTaskWeekday, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun"
};
export const WEEKDAY_LONG_LABELS: Record<ScheduledTaskWeekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday"
};
export const WORKDAYS: readonly ScheduledTaskWeekday[] = SCHEDULED_TASK_WEEKDAYS.slice(0, 5);
