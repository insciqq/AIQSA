import {
  SCHEDULED_TASK_WEEKDAYS,
  scheduledTaskErrorMessage,
  type ScheduledTask,
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
  const year = parts.year !== instantParts(now, zone).year ? ` ${parts.year}` : "";
  return `${parts.weekday} ${Number(parts.day)} ${MONTH_LABELS[Number(parts.month) - 1] ?? parts.month}${year}, ${parts.hour}:${parts.minute}`;
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

/** Why a task paused itself and how to recover. */
export function scheduledTaskPauseCopy(reasonCode: string): PauseCopy {
  switch (reasonCode) {
    case "model_unavailable":
      return { reason: "the model is no longer available", hint: "Edit to choose another model." };
    case "search_unavailable":
      return { reason: "web search is no longer available with this model", hint: "Edit to turn it off or choose another model." };
    case "repeated_failures":
      return { reason: "the last three runs failed", hint: "Resume to try again." };
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
    case "model_unavailable": return "the model was unavailable";
    case "search_unavailable": return "web search was unavailable with this model";
    case "repeated_failures": return "the task was paused after repeated failures";
    case "provider_error":
    case "run_failed": return "the model did not return an answer";
    default: return state === "failed" ? "the answer did not complete" : "the run was not started";
  }
}

export type ScheduledTaskStatusLine = Readonly<{
  text: string;
  tone: "neutral" | "live" | "attention";
}>;

/** The one status sentence a row shows: next run, running, paused (with reason) or completed. */
export function scheduledTaskStatusLine(task: ScheduledTask, now: Date = new Date()): ScheduledTaskStatusLine {
  if (task.running) return { text: "Running now", tone: "live" };
  if (task.status === "completed") return { text: "Completed", tone: "neutral" };
  if (task.status === "paused") {
    if (!task.pauseReason) return { text: "Paused", tone: "neutral" };
    const copy = scheduledTaskPauseCopy(task.pauseReason);
    return { text: `Paused: ${copy.reason}. ${copy.hint}`, tone: "attention" };
  }
  return task.nextRunAt
    ? { text: `Next run ${formatScheduledInstant(task.nextRunAt, task.timeZone, now)}`, tone: "neutral" }
    : { text: "No upcoming run", tone: "neutral" };
}

function outcomeText(state: ScheduledTaskRun["state"], reasonCode: string | null): string {
  switch (state) {
    case "completed": return "Answered";
    case "failed": return `Failed: ${scheduledTaskRunReasonText("failed", reasonCode)}`;
    case "skipped": return `Skipped: ${scheduledTaskRunReasonText("skipped", reasonCode)}`;
    case "running": return "Running";
    case "pending": return "Starting";
  }
}

/** "Last run Mon 5 Oct, 09:00 · Answered", or null before the first settled run. */
export function scheduledTaskLastRunLine(task: ScheduledTask, now: Date = new Date()): string | null {
  if (!task.lastRun) return null;
  return `Last run ${formatScheduledInstant(task.lastRun.scheduledFor, task.timeZone, now)} · ${outcomeText(task.lastRun.state, task.lastRun.reasonCode)}`;
}

export type ScheduledTaskRunRow = Readonly<{ time: string; trigger: string; outcome: string; tone: "neutral" | "attention" | "live" }>;

export function scheduledTaskRunRow(run: ScheduledTaskRun, timeZone: string, now: Date = new Date()): ScheduledTaskRunRow {
  return {
    outcome: outcomeText(run.state, run.reasonCode),
    time: formatScheduledInstant(run.startedAt ?? run.scheduledFor, timeZone, now),
    tone: run.state === "failed" ? "attention" : run.state === "pending" || run.state === "running" ? "live" : "neutral",
    trigger: run.trigger === "manual" ? "Run now" : "Scheduled"
  };
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
