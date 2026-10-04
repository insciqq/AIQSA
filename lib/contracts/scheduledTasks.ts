/**
 * Scheduled tasks wire contract, shared by the owner API (`/api/me/scheduled-tasks`),
 * the runner and the Studio UI. Schedule computation lives in
 * `lib/domain/scheduledTaskSchedule.ts`; this leaf only owns shapes and bounds.
 */

export const SCHEDULED_TASK_MAX_ACTIVE = 10;
export const SCHEDULED_TASK_MAX_TOTAL = 50;
/** Active hourly tasks per owner, counted within the active limit. */
export const SCHEDULED_TASK_MAX_ACTIVE_HOURLY = 3;
/** Code points after trimming; equals the chat title bound because the title names the task's chat. */
export const SCHEDULED_TASK_TITLE_MAX_LENGTH = 120;
/** Code points. */
export const SCHEDULED_TASK_PROMPT_MAX_LENGTH = 8_000;
export const SCHEDULED_TASK_TIME_ZONE_MAX_LENGTH = 64;
export const SCHEDULED_TASK_MODEL_IDENTITY_MAX_LENGTH = 256;
/** A once task must start later than now plus this lead on create, edit and resume. */
export const SCHEDULED_TASK_ONCE_MIN_LEAD_MS = 60_000;
export const SCHEDULED_TASK_RECENT_RUNS_LIMIT = 10;
/** Results one mark-seen request may name; the newest 50 runs of a task are kept. */
export const SCHEDULED_TASK_SEEN_RUNS_LIMIT = 50;

export const SCHEDULED_TASK_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type ScheduledTaskWeekday = (typeof SCHEDULED_TASK_WEEKDAYS)[number];
/** Hourly intervals divide the day evenly; one hour is the minimum. */
export const SCHEDULED_TASK_EVERY_HOURS = [1, 2, 3, 4, 6, 8, 12] as const;
export type ScheduledTaskEveryHours = (typeof SCHEDULED_TASK_EVERY_HOURS)[number];

/**
 * Wall-clock schedule in the task's IANA time zone: `time` is "HH:MM" (24-hour),
 * `date` is "YYYY-MM-DD". Weekly and hourly `days` are unique and listed Monday
 * first; "weekdays" is a UI preset of mon..fri. A monthly day past the month's
 * end runs on its last day. An hourly schedule runs every `everyHours` from
 * `time` (the window start, "00:00" for the whole day) through `until`
 * inclusive (the window end, later than `time`; null: through the end of the
 * day) on `days`; the spacing is nominal wall-clock time.
 */
export type ScheduledTaskSchedule =
  | { kind: "once"; date: string; time: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; days: ScheduledTaskWeekday[] }
  | { kind: "monthly"; time: string; dayOfMonth: number }
  | { kind: "hourly"; everyHours: ScheduledTaskEveryHours; time: string; until: string | null; days: ScheduledTaskWeekday[] };

/**
 * `new`: every run, Run now included, starts its own Memory-excluded chat.
 * `same`: runs continue in the task's chat. Hourly tasks are always `same`.
 */
export type ScheduledTaskChatMode = "new" | "same";
export const SCHEDULED_TASK_CHAT_MODES = ["new", "same"] as const satisfies readonly ScheduledTaskChatMode[];

export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskRunState = "pending" | "running" | "completed" | "failed" | "skipped";
export type ScheduledTaskSettledRunState = Extract<ScheduledTaskRunState, "completed" | "failed" | "skipped">;
export type ScheduledTaskRunTrigger = "schedule" | "manual";

/** The newest settled occurrence. */
export type ScheduledTaskLastRun = {
  scheduledFor: string;
  state: ScheduledTaskSettledRunState;
  reasonCode: string | null;
  finishedAt: string;
};

export type ScheduledTask = {
  id: string;
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  timeZone: string;
  modelId: string;
  provider: string;
  searchEnabled: boolean;
  emailNotify: boolean;
  chatMode: ScheduledTaskChatMode;
  status: ScheduledTaskStatus;
  /** Stable code of an automatic pause; null for owner pauses and other states. */
  pauseReason: string | null;
  /** Null unless active. */
  nextRunAt: string | null;
  lastRun: ScheduledTaskLastRun | null;
  /** A pending or running occurrence exists. */
  running: boolean;
  /**
   * The newest chat a run used while it is usable: the one to open. Null before
   * the first run or after its deletion. Every run keeps its own `chatId`.
   */
  chatId: string | null;
  /** Some run's result has not been seen yet (see `ScheduledTaskRun.unseen`). */
  unseenResult: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Content-free occurrence history. */
export type ScheduledTaskRun = {
  /** Opaque id, used only to mark this run's result seen. */
  id: string;
  scheduledFor: string;
  trigger: ScheduledTaskRunTrigger;
  state: ScheduledTaskRunState;
  reasonCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  chatId: string | null;
  /**
   * The result is news the owner has not seen: a finished answer or a failure
   * that paused the task. Routine skips and other failures stay history only.
   */
  unseen: boolean;
};

export type ScheduledTaskLimits = { maxActive: number; maxTotal: number; maxActiveHourly: number };
/** `GET /api/me/scheduled-tasks`, newest first. `emailAvailable`: installation SMTP is configured and the account has an address. */
export type ScheduledTaskListResponse = { tasks: ScheduledTask[]; limits: ScheduledTaskLimits; emailAvailable: boolean };
/** `GET /api/me/scheduled-tasks/[taskId]`; `recentRuns` holds the newest occurrences first. */
export type ScheduledTaskDetailResponse = { task: ScheduledTask; recentRuns: ScheduledTaskRun[] };
/**
 * Response of create (201), update (200) and `POST /api/me/scheduled-tasks/[taskId]/run`
 * (200), which queues a manual run now in any status without changing the
 * schedule or status and refuses with `scheduled_task_running` while a run is open.
 */
export type ScheduledTaskResponse = { task: ScheduledTask };
/**
 * `POST /api/me/scheduled-tasks/[taskId]/seen` (204): the results the viewer
 * has rendered, by `ScheduledTaskRun.id` (the run history, or the
 * `taskRunId` of a scheduled turn in a chat). Only these results become seen,
 * so a result that settles meanwhile stays unread.
 */
export type ScheduledTaskSeenRequest = { runIds: string[] };

/** Every editable field; also the `POST /api/me/scheduled-tasks` body, which creates an active task. */
export type ScheduledTaskDraft = {
  title: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  timeZone: string;
  /** The composer's `modelId` and `provider`; they travel together. */
  modelId: string;
  provider: string;
  searchEnabled: boolean;
  emailNotify: boolean;
  /** `new` is the default the editor offers; hourly schedules require `same`. */
  chatMode: ScheduledTaskChatMode;
};
export type ScheduledTaskCreateRequest = ScheduledTaskDraft;
/**
 * `PATCH /api/me/scheduled-tasks/[taskId]`: `expectedRevision` plus at least one
 * change. Pausing clears the next run; resuming or changing the schedule or time
 * zone takes the next occurrence from now without catch-up, while other edits
 * keep an active task's due run. Every update clears the failure count and the
 * pause reason. A schedule change reactivates a completed once task. A change
 * to an hourly schedule must also send `chatMode: "same"` unless the task
 * already continues in one chat.
 */
export type ScheduledTaskUpdateRequest = Partial<ScheduledTaskDraft> & {
  expectedRevision: number;
  status?: "active" | "paused";
};

export const SCHEDULED_TASK_ERROR_CODES = [
  "scheduled_task_invalid",
  "scheduled_task_schedule_invalid",
  "scheduled_task_time_zone_invalid",
  "scheduled_task_once_in_past",
  "scheduled_task_chat_mode_invalid",
  "scheduled_task_model_unavailable",
  "scheduled_task_search_unavailable",
  "scheduled_task_limit",
  "scheduled_task_hourly_limit",
  "scheduled_task_stale",
  "scheduled_task_not_found",
  "scheduled_task_running",
  "scheduled_tasks_unavailable"
] as const;
export type ScheduledTaskErrorCode = (typeof SCHEDULED_TASK_ERROR_CODES)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && Object.keys(value).every((key) => allowed.includes(key));
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function instant(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function nullable<T>(value: unknown, check: (entry: unknown) => entry is T): value is T | null {
  return value === null || check(value);
}
function code(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}
function count(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** Proleptic Gregorian month length; `month` is 1..12. */
export function scheduledTaskDaysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
/** A real calendar date written as "YYYY-MM-DD". */
export function isScheduledTaskLocalDate(value: unknown): value is string {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= scheduledTaskDaysInMonth(year, month);
}
export function isScheduledTaskTime(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value);
}
/** Bounded IANA-shaped name; the runtime decides whether it resolves. */
export function isScheduledTaskTimeZoneShape(value: unknown): value is string {
  return typeof value === "string" && value.length <= SCHEDULED_TASK_TIME_ZONE_MAX_LENGTH && TIME_ZONE.test(value);
}
/** The trimmed title when it has 1..120 code points, else null. */
export function normalizeScheduledTaskTitle(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const title = value.trim();
  return title && codePointLength(title) <= SCHEDULED_TASK_TITLE_MAX_LENGTH ? title : null;
}
/** Stored as written; it must contain non-whitespace text within the bound. */
export function isScheduledTaskPrompt(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && value.trim().length > 0 &&
    codePointLength(value) <= SCHEDULED_TASK_PROMPT_MAX_LENGTH;
}
export function isScheduledTaskModelIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SCHEDULED_TASK_MODEL_IDENTITY_MAX_LENGTH;
}

/** Unique weekdays (1..7), normalized Monday first; null when malformed. */
function weekdays(value: unknown): ScheduledTaskWeekday[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > SCHEDULED_TASK_WEEKDAYS.length ||
    new Set(value).size !== value.length ||
    !value.every((day) => (SCHEDULED_TASK_WEEKDAYS as readonly unknown[]).includes(day))) return null;
  return SCHEDULED_TASK_WEEKDAYS.filter((day) => value.includes(day));
}

/**
 * Strict schedule decoding: exact keys, valid wall-clock values, weekly and
 * hourly days normalized Monday first, an hourly window end later than its start.
 */
export function decodeScheduledTaskSchedule(value: unknown): ScheduledTaskSchedule | null {
  if (!record(value) || !isScheduledTaskTime(value.time)) return null;
  switch (value.kind) {
    case "once":
      return keys(value, ["kind", "date", "time"]) && isScheduledTaskLocalDate(value.date)
        ? { kind: "once", date: value.date, time: value.time }
        : null;
    case "daily":
      return keys(value, ["kind", "time"]) ? { kind: "daily", time: value.time } : null;
    case "weekly": {
      const days = weekdays(value.days);
      return keys(value, ["kind", "time", "days"]) && days ? { kind: "weekly", time: value.time, days } : null;
    }
    case "monthly":
      return keys(value, ["kind", "time", "dayOfMonth"]) && count(value.dayOfMonth, 1) && value.dayOfMonth <= 31
        ? { kind: "monthly", time: value.time, dayOfMonth: value.dayOfMonth }
        : null;
    case "hourly": {
      const days = weekdays(value.days);
      const everyHours = (SCHEDULED_TASK_EVERY_HOURS as readonly unknown[]).includes(value.everyHours)
        ? value.everyHours as ScheduledTaskEveryHours : null;
      const until = value.until;
      // "HH:MM" strings compare in time order.
      if (!keys(value, ["kind", "everyHours", "time", "until", "days"]) || !days || !everyHours ||
        (until !== null && (!isScheduledTaskTime(until) || until <= value.time))) return null;
      return { kind: "hourly", everyHours, time: value.time, until, days };
    }
    default:
      return null;
  }
}

/** Hourly tasks always continue in one chat; every other kind may start a new chat per run. */
export function scheduledTaskChatModeAllowed(schedule: ScheduledTaskSchedule, chatMode: ScheduledTaskChatMode): boolean {
  return chatMode === "same" || schedule.kind !== "hourly";
}

const TASK_KEYS = [
  "id", "title", "prompt", "schedule", "timeZone", "modelId", "provider", "searchEnabled", "emailNotify", "chatMode",
  "status", "pauseReason", "nextRunAt", "lastRun", "running", "chatId", "unseenResult", "revision", "createdAt", "updatedAt"
] as const;
const STATUSES: readonly unknown[] = ["active", "paused", "completed"] satisfies ScheduledTaskStatus[];
const CHAT_MODES: readonly unknown[] = SCHEDULED_TASK_CHAT_MODES;
const RUN_STATES: readonly unknown[] = ["pending", "running", "completed", "failed", "skipped"] satisfies ScheduledTaskRunState[];
const SETTLED_RUN_STATES: readonly unknown[] = ["completed", "failed", "skipped"] satisfies ScheduledTaskSettledRunState[];

function lastRun(value: unknown): value is ScheduledTaskLastRun {
  return record(value) && keys(value, ["scheduledFor", "state", "reasonCode", "finishedAt"]) &&
    instant(value.scheduledFor) && SETTLED_RUN_STATES.includes(value.state) &&
    nullable(value.reasonCode, code) && instant(value.finishedAt);
}

export function decodeScheduledTask(value: unknown): ScheduledTask | null {
  if (!record(value) || !keys(value, TASK_KEYS)) return null;
  const schedule = decodeScheduledTaskSchedule(value.schedule);
  const title = normalizeScheduledTaskTitle(value.title), prompt = value.prompt;
  if (!schedule || !id(value.id) || !title || title !== value.title || !isScheduledTaskPrompt(prompt) ||
    !isScheduledTaskTimeZoneShape(value.timeZone) || !isScheduledTaskModelIdentity(value.modelId) ||
    !isScheduledTaskModelIdentity(value.provider) || typeof value.searchEnabled !== "boolean" ||
    typeof value.emailNotify !== "boolean" || !CHAT_MODES.includes(value.chatMode) ||
    !scheduledTaskChatModeAllowed(schedule, value.chatMode as ScheduledTaskChatMode) || !STATUSES.includes(value.status) ||
    !nullable(value.pauseReason, code) ||
    !nullable(value.nextRunAt, instant) || (value.status !== "active" && value.nextRunAt !== null) ||
    !nullable(value.lastRun, lastRun) || typeof value.running !== "boolean" || !nullable(value.chatId, id) ||
    typeof value.unseenResult !== "boolean" || !count(value.revision, 1) || !instant(value.createdAt) ||
    !instant(value.updatedAt)) return null;
  const run = value.lastRun as ScheduledTaskLastRun | null;
  return {
    id: value.id, title, prompt, schedule, timeZone: value.timeZone, modelId: value.modelId, provider: value.provider,
    searchEnabled: value.searchEnabled, emailNotify: value.emailNotify, chatMode: value.chatMode as ScheduledTaskChatMode,
    status: value.status as ScheduledTaskStatus, pauseReason: value.pauseReason, nextRunAt: value.nextRunAt,
    lastRun: run && { scheduledFor: run.scheduledFor, state: run.state, reasonCode: run.reasonCode, finishedAt: run.finishedAt },
    running: value.running, chatId: value.chatId, unseenResult: value.unseenResult, revision: value.revision,
    createdAt: value.createdAt, updatedAt: value.updatedAt
  };
}

const RUN_KEYS = ["id", "scheduledFor", "trigger", "state", "reasonCode", "startedAt", "finishedAt", "chatId", "unseen"] as const;

export function decodeScheduledTaskRun(value: unknown): ScheduledTaskRun | null {
  if (!record(value) || !keys(value, RUN_KEYS) || !id(value.id) ||
    !instant(value.scheduledFor) || (value.trigger !== "schedule" && value.trigger !== "manual") ||
    !RUN_STATES.includes(value.state) || !nullable(value.reasonCode, code) || !nullable(value.startedAt, instant) ||
    !nullable(value.finishedAt, instant) || !nullable(value.chatId, id) || typeof value.unseen !== "boolean" ||
    (value.unseen && value.finishedAt === null)) return null;
  return {
    id: value.id, scheduledFor: value.scheduledFor, trigger: value.trigger, state: value.state as ScheduledTaskRunState,
    reasonCode: value.reasonCode, startedAt: value.startedAt, finishedAt: value.finishedAt, chatId: value.chatId,
    unseen: value.unseen
  };
}

export function decodeScheduledTaskListResponse(value: unknown): ScheduledTaskListResponse | null {
  if (!record(value) || !keys(value, ["tasks", "limits", "emailAvailable"]) || !Array.isArray(value.tasks) ||
    value.tasks.length > SCHEDULED_TASK_MAX_TOTAL || typeof value.emailAvailable !== "boolean" ||
    !record(value.limits) || !keys(value.limits, ["maxActive", "maxTotal", "maxActiveHourly"]) ||
    !count(value.limits.maxActive, 0) || !count(value.limits.maxTotal, 0) || !count(value.limits.maxActiveHourly, 0)) return null;
  const tasks = value.tasks.map(decodeScheduledTask);
  if (tasks.some((task) => !task) || new Set(tasks.map((task) => task!.id)).size !== tasks.length) return null;
  return {
    tasks: tasks as ScheduledTask[],
    limits: { maxActive: value.limits.maxActive, maxTotal: value.limits.maxTotal, maxActiveHourly: value.limits.maxActiveHourly },
    emailAvailable: value.emailAvailable
  };
}

export function decodeScheduledTaskDetailResponse(value: unknown): ScheduledTaskDetailResponse | null {
  if (!record(value) || !keys(value, ["task", "recentRuns"]) || !Array.isArray(value.recentRuns) ||
    value.recentRuns.length > SCHEDULED_TASK_RECENT_RUNS_LIMIT) return null;
  const task = decodeScheduledTask(value.task);
  const recentRuns = value.recentRuns.map(decodeScheduledTaskRun);
  return task && recentRuns.every(Boolean) ? { task, recentRuns: recentRuns as ScheduledTaskRun[] } : null;
}

/** `POST /seen` body: 1..50 unique run ids, nothing else. */
export function decodeScheduledTaskSeenRequest(value: unknown): ScheduledTaskSeenRequest | null {
  if (!record(value) || !keys(value, ["runIds"]) || !Array.isArray(value.runIds) || value.runIds.length < 1 ||
    value.runIds.length > SCHEDULED_TASK_SEEN_RUNS_LIMIT || !value.runIds.every(id) ||
    new Set(value.runIds).size !== value.runIds.length) return null;
  return { runIds: [...value.runIds] as string[] };
}

export function scheduledTaskErrorMessage(errorCode: unknown): string {
  switch (errorCode) {
    case "scheduled_task_invalid": return "Check the task name, instructions and settings.";
    case "scheduled_task_schedule_invalid": return "Check the schedule.";
    case "scheduled_task_time_zone_invalid": return "Choose a valid time zone.";
    case "scheduled_task_once_in_past": return "Choose a time at least a minute from now.";
    case "scheduled_task_chat_mode_invalid": return "Hourly tasks always continue in the same chat.";
    case "scheduled_task_model_unavailable": return "This model is no longer available to you. Choose another model.";
    case "scheduled_task_search_unavailable": return "Web search is not available with this model. Turn it off or choose another model.";
    case "scheduled_task_limit":
      return `You can have up to ${SCHEDULED_TASK_MAX_ACTIVE} active and ${SCHEDULED_TASK_MAX_TOTAL} saved scheduled tasks.`;
    case "scheduled_task_hourly_limit":
      return `You can have up to ${SCHEDULED_TASK_MAX_ACTIVE_HOURLY} active hourly tasks. Pause one or choose a less frequent schedule.`;
    case "scheduled_task_stale": return "This task was changed elsewhere. Reload it and try again; your unsaved changes are kept.";
    case "scheduled_task_not_found": return "This task is no longer available.";
    case "scheduled_task_running": return "This task is already running. Wait for the current run to finish.";
    default: return "Scheduled tasks are unavailable right now. Try again.";
  }
}

/** Human copy for a pause reason or an occurrence reason code; unknown codes get a generic line. */
export function scheduledTaskReasonMessage(reasonCode: string | null): string | null {
  switch (reasonCode) {
    case null: return null;
    case "model_unavailable": return "The model is no longer available. Choose another model and resume.";
    case "search_unavailable": return "Web search is no longer available with this model. Turn it off or choose another model and resume.";
    case "provider_unavailable": return "The model's provider is unavailable right now. Check the model and resume.";
    case "account_inactive": return "Paused while the account was not active. Resume to continue.";
    case "schedule_invalid": return "The schedule can no longer be calculated. Edit the schedule and resume.";
    case "repeated_failures": return "Paused after three failed runs in a row.";
    case "missed": return "Skipped: the scheduled time passed while runs were unavailable.";
    case "previous_running": return "Skipped: the previous run was still in progress.";
    case "superseded": return "Skipped: a newer scheduled time arrived before this run could start.";
    case "chat_busy": return "Skipped: the task's chat was busy.";
    case "paused": return "Skipped: the task was paused.";
    case "admission_failed": return "The run could not start.";
    case "run_unavailable": return "The task's chat was deleted before the run finished.";
    case "model_run_cancelled": return "Stopped in the chat.";
    default: return "The run did not complete.";
  }
}
