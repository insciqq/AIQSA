/**
 * Scheduled tasks wire contract, shared by the owner API (`/api/me/scheduled-tasks`),
 * the runner and the Studio UI. Schedule computation lives in
 * `lib/domain/scheduledTaskSchedule.ts`; this leaf only owns shapes and bounds.
 */

import type { ChatDefaultMcpMode } from "./chatDefaults";

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
/** A scheduled run is stopped this long after its admission and ends `run_deadline`. */
export const SCHEDULED_TASK_RUN_DEADLINE_MINUTES = 30;
/** Scheduled runs in a row that complete without a relevant source before the task pauses (`source_unavailable`). */
export const SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD = 3;
/** Unavailable sources one run records; at most the enabled MCP servers of one plan. */
export const SCHEDULED_TASK_UNAVAILABLE_SOURCES_LIMIT = 64;
/** Code points of a recorded source name; longer display names are shortened with an ellipsis. */
export const SCHEDULED_TASK_SOURCE_NAME_MAX_LENGTH = 120;
/** Skills one task may pin; every run loads exactly them at their current version. */
export const SCHEDULED_TASK_MAX_PINNED_SKILLS = 4;
/** Bound of a pinned Skill id, as the composer's pinned Skill ids. */
export const SCHEDULED_TASK_SKILL_ID_MAX_LENGTH = 64;
/** Code points of a pinned Skill's name as a task projects it, the Skill name bound. */
export const SCHEDULED_TASK_SKILL_NAME_MAX_LENGTH = 64;
/**
 * Days a chat the task created is kept after its last run once it is no longer
 * the task's chat; `null` keeps such chats forever.
 */
export const SCHEDULED_TASK_HISTORY_RETENTION_DAYS = [30, 90, 365] as const;
export type ScheduledTaskHistoryRetentionDays = (typeof SCHEDULED_TASK_HISTORY_RETENTION_DAYS)[number] | null;
/** What a new task keeps; tasks saved before the choice existed keep everything. */
export const SCHEDULED_TASK_DEFAULT_HISTORY_RETENTION_DAYS = 90 satisfies ScheduledTaskHistoryRetentionDays;

export function isScheduledTaskHistoryRetentionDays(value: unknown): value is ScheduledTaskHistoryRetentionDays {
  return value === null || (SCHEDULED_TASK_HISTORY_RETENTION_DAYS as readonly unknown[]).includes(value);
}

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
 * `same`: runs continue in the task's chat, which starts anew with the first
 * run of each calendar month in the task's zone. Hourly and monitoring tasks
 * are always `same`.
 */
export type ScheduledTaskChatMode = "new" | "same";
export const SCHEDULED_TASK_CHAT_MODES = ["new", "same"] as const satisfies readonly ScheduledTaskChatMode[];

/**
 * `standard`: every completed run is a shown result. `monitoring`: each run is
 * a check whose model reports through a built-in tool whether anything changed
 * since the previous shown result; only checks with news are shown and notify,
 * and a reached goal completes the task. Monitoring needs a model that can
 * call tools and always continues in one chat.
 */
export type ScheduledTaskKind = "standard" | "monitoring";
export const SCHEDULED_TASK_KINDS = ["standard", "monitoring"] as const satisfies readonly ScheduledTaskKind[];

/**
 * The settled outcome of a monitoring check, the `reasonCode` of its completed
 * run and the transcript marker of its turn. Only `no_update` is hidden: it is
 * neither shown in the chat, nor unread, nor notified, nor the next check's
 * previous result. `baseline` is the first check of a task or after a changed
 * prompt, schedule kind or type; `unreported` is a check whose model never
 * reported, shown because an update is never hidden by mistake;
 * `could_not_check` is a check that missed a source its previous shown result
 * relied on: shown, but news only as the source alert or a pause, and never
 * the next check's previous result.
 */
export type ScheduledTaskCheckOutcome = "baseline" | "update" | "no_update" | "goal_reached" | "unreported" |
  "could_not_check";
export const SCHEDULED_TASK_CHECK_OUTCOMES = [
  "baseline", "update", "no_update", "goal_reached", "unreported", "could_not_check"
] as const satisfies readonly ScheduledTaskCheckOutcome[];

export function isScheduledTaskCheckOutcome(value: unknown): value is ScheduledTaskCheckOutcome {
  return (SCHEDULED_TASK_CHECK_OUTCOMES as readonly unknown[]).includes(value);
}

export type ScheduledTaskStatus = "active" | "paused" | "completed";
export type ScheduledTaskRunState = "pending" | "running" | "completed" | "failed" | "skipped";
export type ScheduledTaskSettledRunState = Extract<ScheduledTaskRunState, "completed" | "failed" | "skipped">;
export type ScheduledTaskRunTrigger = "schedule" | "manual";

/**
 * One of a task's pinned Skills as its owner may see it now. `name` is null
 * when the Skill is gone or no longer visible to the owner (deleted, or no
 * longer shared), so its name never outlives the owner's access. `available`:
 * a run can load it (not archived, enabled for the owner, still shared).
 * `hasExecutables`: its version a run would load has scripts, which need Workspace.
 */
export type ScheduledTaskPinnedSkill = Readonly<{
  id: string;
  name: string | null;
  available: boolean;
  hasExecutables: boolean;
}>;

/** A pinned Skill a run loaded: the name and version (revision number) it used, content-free. */
export type ScheduledTaskRunSkill = Readonly<{ name: string; version: number }>;

/** The newest settled occurrence. */
export type ScheduledTaskLastRun = {
  scheduledFor: string;
  state: ScheduledTaskSettledRunState;
  reasonCode: string | null;
  finishedAt: string;
  /** This run's result is not seen yet, by the rule of `ScheduledTaskRun.unseen`. */
  unseen: boolean;
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
  /** See `ScheduledTaskDraft.toolsEnabled`. */
  toolsEnabled: boolean;
  /** See `ScheduledTaskDraft.workspaceEnabled`. */
  workspaceEnabled: boolean;
  /** See `ScheduledTaskDraft.memoryEnabled`. */
  memoryEnabled: boolean;
  /** See `ScheduledTaskDraft.pinnedSkillIds`. */
  pinnedSkillIds: string[];
  /**
   * The pinned Skills as the owner may see them now, in `pinnedSkillIds`
   * order. The owner API always projects them; a task in a chat card or a
   * model tool result omits them.
   */
  pinnedSkills?: ScheduledTaskPinnedSkill[];
  chatMode: ScheduledTaskChatMode;
  kind: ScheduledTaskKind;
  /** See `ScheduledTaskDraft.historyRetentionDays`. */
  historyRetentionDays: ScheduledTaskHistoryRetentionDays;
  /** Old chats of this task its history retention deleted; a count only. */
  historyDeletedChats: number;
  /**
   * When the history retention deletes the next old chat of this task as
   * things stand (the owner can still keep it); null when none is due.
   * Projections without the task's history (cards, tool results) say null.
   */
  historyNextDeletionAt: string | null;
  status: ScheduledTaskStatus;
  /** Stable code of an automatic pause; null for owner pauses and other states. */
  pauseReason: string | null;
  /**
   * Why a completed task stopped: `goal_reached` when a monitoring check met
   * its goal. Null for a once task's single run and for other states.
   */
  completionReason: string | null;
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
  /**
   * The instructions hold links runs cannot read yet: they were saved before
   * page reading, or a chat tool wrote them without the user's own links.
   * Saving the instructions allows them. Absent otherwise; never the links.
   */
  promptLinksPending?: true;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * Why a run could not use one of the owner's sources: `mcp_reauthorization_required`
 * (the personal MCP server needs sign-in again) or `mcp_server_unavailable`
 * (it is not ready or needs setup).
 */
export type ScheduledTaskSourceReason = "mcp_reauthorization_required" | "mcp_server_unavailable";
export const SCHEDULED_TASK_SOURCE_REASONS = [
  "mcp_reauthorization_required", "mcp_server_unavailable"
] as const satisfies readonly ScheduledTaskSourceReason[];

/** A source the run's previous result relied on (or any, before a first result) that its tools could not reach. */
export type ScheduledTaskUnavailableSource = { name: string; reason: ScheduledTaskSourceReason };

/** Content-free occurrence history. */
export type ScheduledTaskRun = {
  /** Opaque id, used only to mark this run's result seen. */
  id: string;
  scheduledFor: string;
  trigger: ScheduledTaskRunTrigger;
  state: ScheduledTaskRunState;
  /** Why it was skipped or failed; for a completed monitoring check its `ScheduledTaskCheckOutcome`. */
  reasonCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  chatId: string | null;
  /**
   * The result is news the owner has not seen: a finished answer (except a
   * monitoring check with no update, and one that could not check unless it
   * alerted or paused), a settlement that paused the task, or the first run
   * of a streak that missed a source. Routine skips and other failures stay
   * history only.
   */
  unseen: boolean;
  /**
   * Source health, frozen when the run was accepted: the relevant sources its
   * tools could not reach. Non-empty means the run is incomplete (see
   * `isScheduledTaskRunIncomplete`); its answer still completed.
   */
  unavailableSources: ScheduledTaskUnavailableSource[];
  /** The task's pinned Skills the run loaded, with the version each used; empty without pins or a run. */
  skills: ScheduledTaskRunSkill[];
};

/**
 * A run that went ahead without a relevant source: its result could not check
 * everything the task relies on. Separate from the run state, which stays
 * `completed` for such a run.
 */
export function isScheduledTaskRunIncomplete(run: Readonly<Pick<ScheduledTaskRun, "unavailableSources">>): boolean {
  return run.unavailableSources.length > 0;
}

/** Owner-facing line for one unavailable source, for run history and notifications. */
export function scheduledTaskSourceMessage(source: Readonly<ScheduledTaskUnavailableSource>): string {
  return source.reason === "mcp_reauthorization_required"
    ? `${source.name} needs sign-in.`
    : `${source.name} is unavailable.`;
}

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
  /**
   * Runs use the owner's MCP tools and Skills, both in Auto mode, as an
   * ordinary message does. Needs a model with tool calling.
   */
  toolsEnabled: boolean;
  /**
   * Runs use the task chat's Workspace: in `same` mode files persist from run
   * to run; in `new` mode each run starts a fresh one. Needs a model with
   * tool calling and an installation with Workspace on.
   */
  workspaceEnabled: boolean;
  /**
   * Runs read what the owner's Memory holds (standing context and, with a
   * tool-calling model, Memory search) and never add to it, whatever the
   * task chat's Memory mode; the owner's Memory settings still decide what
   * may be read. New tasks start with it on.
   */
  memoryEnabled: boolean;
  /**
   * Up to `SCHEDULED_TASK_MAX_PINNED_SKILLS` unique ids of Skills available
   * to the owner that every run loads at their current version beside the
   * Auto catalog; only with `toolsEnabled`. A pinned Skill that is no longer
   * available pauses the task (`skill_unavailable`); a run never goes on in
   * Auto without it. Optional in a create body (none). Changing the pins
   * keeps the task's previous result.
   */
  pinnedSkillIds: string[];
  /** `new` is the default the editor offers; hourly schedules and monitoring tasks require `same`. */
  chatMode: ScheduledTaskChatMode;
  /** `monitoring` requires a model that can call tools. */
  kind: ScheduledTaskKind;
  /**
   * How long the task's old chats are kept after their last run: 30, 90 or
   * 365 days, or null for forever. Only chats the task's runs created count,
   * never its current chat, and a chat the owner wrote in, pinned, put in a
   * folder, shared, renamed or restored from the archive is always kept.
   * Optional in a create body: new tasks keep 90 days.
   */
  historyRetentionDays: ScheduledTaskHistoryRetentionDays;
};
export type ScheduledTaskCreateRequest = ScheduledTaskDraft;

/**
 * The switches a new task starts with: the owner's composer defaults as the
 * catalog publishes them (`Catalog.defaults`). Tools are on unless MCP
 * defaults to Off; Workspace follows the composer's Workspace default. The
 * editor still turns both off for a model without tool calling.
 */
export function scheduledTaskToolDefaults(defaults: Readonly<{ mcpMode?: ChatDefaultMcpMode; workspaceEnabled?: boolean }>):
  Pick<ScheduledTaskDraft, "toolsEnabled" | "workspaceEnabled"> {
  return { toolsEnabled: defaults.mcpMode !== "off", workspaceEnabled: defaults.workspaceEnabled === true };
}
/**
 * `PATCH /api/me/scheduled-tasks/[taskId]`: `expectedRevision` plus at least one
 * change. Pausing clears the next run; resuming or changing the schedule or time
 * zone takes the next occurrence from now without catch-up, while other edits
 * keep an active task's due run. Every update clears the failure, incomplete-run
 * and missing report counts and the pause reason; leaving the completed status
 * clears the completion reason. A schedule change reactivates a completed task.
 * A change to an hourly schedule or to monitoring must also send
 * `chatMode: "same"` unless the task already continues in one chat. A changed
 * prompt, schedule kind or type starts the task's checks afresh: the next run
 * has no previous result. Turning tools or Workspace on, like an active
 * result, rechecks them against the model; changed pinned Skills and those of
 * an active result are rechecked against the owner's available Skills. Pins
 * never outlive tools: turning tools off needs `pinnedSkillIds: []`. A longer
 * or forever history retention keeps chats that were not yet deleted.
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
  "scheduled_task_model_cannot_report",
  "scheduled_task_search_unavailable",
  "scheduled_task_tools_unavailable",
  "scheduled_task_workspace_unavailable",
  "scheduled_task_skills_need_tools",
  "scheduled_task_skill_unavailable",
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

/**
 * A task's pinned Skill ids: unique, bounded, non-empty strings, at most
 * `SCHEDULED_TASK_MAX_PINNED_SKILLS`, in the given order; null when malformed.
 */
export function decodeScheduledTaskPinnedSkillIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > SCHEDULED_TASK_MAX_PINNED_SKILLS ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0 &&
      entry.length <= SCHEDULED_TASK_SKILL_ID_MAX_LENGTH && entry.trim() === entry) ||
    new Set(value).size !== value.length) return null;
  return [...value] as string[];
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

/**
 * Hourly and monitoring tasks always continue in one chat (a monitoring check
 * compares with the chat's previous shown result); other tasks may start a
 * new chat per run.
 */
export function scheduledTaskChatModeAllowed(
  task: Readonly<{ kind: ScheduledTaskKind; schedule: ScheduledTaskSchedule }>,
  chatMode: ScheduledTaskChatMode
): boolean {
  return chatMode === "same" || (task.schedule.kind !== "hourly" && task.kind !== "monitoring");
}

const TASK_KEYS = [
  "id", "title", "prompt", "schedule", "timeZone", "modelId", "provider", "searchEnabled", "emailNotify", "toolsEnabled",
  "workspaceEnabled", "memoryEnabled", "pinnedSkillIds", "chatMode", "kind", "historyRetentionDays", "historyDeletedChats",
  "historyNextDeletionAt", "status", "pauseReason", "completionReason", "nextRunAt", "lastRun", "running", "chatId",
  "unseenResult", "revision", "createdAt", "updatedAt"
] as const;
const STATUSES: readonly unknown[] = ["active", "paused", "completed"] satisfies ScheduledTaskStatus[];
const CHAT_MODES: readonly unknown[] = SCHEDULED_TASK_CHAT_MODES;
const KINDS: readonly unknown[] = SCHEDULED_TASK_KINDS;
const RUN_STATES: readonly unknown[] = ["pending", "running", "completed", "failed", "skipped"] satisfies ScheduledTaskRunState[];
const SETTLED_RUN_STATES: readonly unknown[] = ["completed", "failed", "skipped"] satisfies ScheduledTaskSettledRunState[];

function lastRun(value: unknown): value is ScheduledTaskLastRun {
  return record(value) && keys(value, ["scheduledFor", "state", "reasonCode", "finishedAt", "unseen"]) &&
    instant(value.scheduledFor) && SETTLED_RUN_STATES.includes(value.state) &&
    nullable(value.reasonCode, code) && instant(value.finishedAt) && typeof value.unseen === "boolean";
}

/**
 * A Skill name as a task projects it: control characters removed, trimmed
 * and shortened to the Skill name bound; null when nothing is left.
 */
export function scheduledTaskSkillNameProjection(name: string): string | null {
  const text = Array.from(name.replace(/[\u0000-\u001f\u007f]/gu, " ").trim())
    .slice(0, SCHEDULED_TASK_SKILL_NAME_MAX_LENGTH).join("").trim();
  return text || null;
}

/** A pinned Skill's projected name: trimmed, control-free text within the Skill name bound. */
function skillName(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value) && codePointLength(value) <= SCHEDULED_TASK_SKILL_NAME_MAX_LENGTH;
}

/** The projected pinned Skills of `ids`, one each in the same order; null when malformed. */
function pinnedSkills(value: unknown, ids: readonly string[]): ScheduledTaskPinnedSkill[] | null {
  if (!Array.isArray(value) || value.length !== ids.length) return null;
  const skills = value.map((entry, index) => record(entry) && keys(entry, ["id", "name", "available", "hasExecutables"]) &&
    entry.id === ids[index] && nullable(entry.name, skillName) && typeof entry.available === "boolean" &&
    typeof entry.hasExecutables === "boolean" && !(entry.available && entry.name === null)
    ? { id: entry.id as string, name: entry.name as string | null, available: entry.available, hasExecutables: entry.hasExecutables }
    : null);
  return skills.every(Boolean) ? skills as ScheduledTaskPinnedSkill[] : null;
}

export function decodeScheduledTask(value: unknown): ScheduledTask | null {
  if (!record(value)) return null;
  const { promptLinksPending, pinnedSkills: projectedSkills, ...fields } = value;
  if (!keys(fields, TASK_KEYS) || (promptLinksPending !== undefined && promptLinksPending !== true)) return null;
  const pinnedSkillIds = decodeScheduledTaskPinnedSkillIds(value.pinnedSkillIds);
  if (!pinnedSkillIds || (pinnedSkillIds.length > 0 && value.toolsEnabled !== true)) return null;
  const skills = projectedSkills === undefined ? undefined : pinnedSkills(projectedSkills, pinnedSkillIds);
  if (skills === null) return null;
  const schedule = decodeScheduledTaskSchedule(value.schedule);
  const title = normalizeScheduledTaskTitle(value.title), prompt = value.prompt;
  if (!schedule || !id(value.id) || !title || title !== value.title || !isScheduledTaskPrompt(prompt) ||
    !isScheduledTaskTimeZoneShape(value.timeZone) || !isScheduledTaskModelIdentity(value.modelId) ||
    !isScheduledTaskModelIdentity(value.provider) || typeof value.searchEnabled !== "boolean" ||
    typeof value.emailNotify !== "boolean" || typeof value.toolsEnabled !== "boolean" ||
    typeof value.workspaceEnabled !== "boolean" || typeof value.memoryEnabled !== "boolean" ||
    !CHAT_MODES.includes(value.chatMode) || !KINDS.includes(value.kind) ||
    !scheduledTaskChatModeAllowed({ kind: value.kind as ScheduledTaskKind, schedule }, value.chatMode as ScheduledTaskChatMode) ||
    !isScheduledTaskHistoryRetentionDays(value.historyRetentionDays) || !count(value.historyDeletedChats, 0) ||
    !nullable(value.historyNextDeletionAt, instant) ||
    !STATUSES.includes(value.status) || !nullable(value.pauseReason, code) ||
    !nullable(value.completionReason, code) || (value.status !== "completed" && value.completionReason !== null) ||
    !nullable(value.nextRunAt, instant) || (value.status !== "active" && value.nextRunAt !== null) ||
    !nullable(value.lastRun, lastRun) || typeof value.running !== "boolean" || !nullable(value.chatId, id) ||
    typeof value.unseenResult !== "boolean" || !count(value.revision, 1) || !instant(value.createdAt) ||
    !instant(value.updatedAt)) return null;
  const run = value.lastRun as ScheduledTaskLastRun | null;
  return {
    id: value.id, title, prompt, schedule, timeZone: value.timeZone, modelId: value.modelId, provider: value.provider,
    searchEnabled: value.searchEnabled, emailNotify: value.emailNotify, toolsEnabled: value.toolsEnabled,
    workspaceEnabled: value.workspaceEnabled, memoryEnabled: value.memoryEnabled, pinnedSkillIds,
    ...(skills ? { pinnedSkills: skills } : {}), chatMode: value.chatMode as ScheduledTaskChatMode,
    kind: value.kind as ScheduledTaskKind, historyRetentionDays: value.historyRetentionDays,
    historyDeletedChats: value.historyDeletedChats, historyNextDeletionAt: value.historyNextDeletionAt,
    status: value.status as ScheduledTaskStatus, pauseReason: value.pauseReason,
    completionReason: value.completionReason, nextRunAt: value.nextRunAt,
    lastRun: run && {
      scheduledFor: run.scheduledFor, state: run.state, reasonCode: run.reasonCode, finishedAt: run.finishedAt, unseen: run.unseen
    },
    running: value.running, chatId: value.chatId, unseenResult: value.unseenResult,
    ...(promptLinksPending ? { promptLinksPending: true as const } : {}), revision: value.revision,
    createdAt: value.createdAt, updatedAt: value.updatedAt
  };
}

const RUN_KEYS = [
  "id", "scheduledFor", "trigger", "state", "reasonCode", "startedAt", "finishedAt", "chatId", "unseen", "unavailableSources",
  "skills"
] as const;
const SOURCE_REASONS: readonly unknown[] = SCHEDULED_TASK_SOURCE_REASONS;

/** A source name as recorded: a trimmed, control-free display name within the bound. */
function sourceName(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value) && codePointLength(value) <= SCHEDULED_TASK_SOURCE_NAME_MAX_LENGTH;
}

/** A bounded list of unavailable sources, or null when malformed. */
export function decodeScheduledTaskUnavailableSources(value: unknown): ScheduledTaskUnavailableSource[] | null {
  if (!Array.isArray(value) || value.length > SCHEDULED_TASK_UNAVAILABLE_SOURCES_LIMIT ||
    !value.every((entry) => record(entry) && keys(entry, ["name", "reason"]) && sourceName(entry.name) &&
      SOURCE_REASONS.includes(entry.reason))) return null;
  return value.map((entry: Record<string, unknown>) => ({
    name: entry.name as string, reason: entry.reason as ScheduledTaskSourceReason
  }));
}

/** The pinned Skills one run loaded, or null when malformed. */
export function decodeScheduledTaskRunSkills(value: unknown): ScheduledTaskRunSkill[] | null {
  if (!Array.isArray(value) || value.length > SCHEDULED_TASK_MAX_PINNED_SKILLS ||
    !value.every((entry) => record(entry) && keys(entry, ["name", "version"]) && skillName(entry.name) &&
      count(entry.version, 1))) return null;
  return value.map((entry: Record<string, unknown>) => ({ name: entry.name as string, version: entry.version as number }));
}

export function decodeScheduledTaskRun(value: unknown): ScheduledTaskRun | null {
  if (!record(value) || !keys(value, RUN_KEYS) || !id(value.id) ||
    !instant(value.scheduledFor) || (value.trigger !== "schedule" && value.trigger !== "manual") ||
    !RUN_STATES.includes(value.state) || !nullable(value.reasonCode, code) || !nullable(value.startedAt, instant) ||
    !nullable(value.finishedAt, instant) || !nullable(value.chatId, id) || typeof value.unseen !== "boolean" ||
    (value.unseen && value.finishedAt === null)) return null;
  const unavailableSources = decodeScheduledTaskUnavailableSources(value.unavailableSources);
  const skills = decodeScheduledTaskRunSkills(value.skills);
  if (!unavailableSources || !skills) return null;
  return {
    id: value.id, scheduledFor: value.scheduledFor, trigger: value.trigger, state: value.state as ScheduledTaskRunState,
    reasonCode: value.reasonCode, startedAt: value.startedAt, finishedAt: value.finishedAt, chatId: value.chatId,
    unseen: value.unseen, unavailableSources, skills
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
    case "scheduled_task_chat_mode_invalid": return "Hourly and monitoring tasks always continue in the same chat.";
    case "scheduled_task_model_unavailable": return "This model is no longer available to you. Choose another model.";
    case "scheduled_task_model_cannot_report": return "Monitoring needs a model that can use tools. Choose another model.";
    case "scheduled_task_search_unavailable": return "Web search is not available with this model. Turn it off or choose another model.";
    case "scheduled_task_tools_unavailable": return "This model cannot use tools. Turn tools off or choose another model.";
    case "scheduled_task_workspace_unavailable":
      return "Workspace is not available for this task. It needs a model with tool support and Workspace turned on by the administrator.";
    case "scheduled_task_skills_need_tools": return "Pinned Skills need tools. Turn tools on or remove the pinned Skills.";
    case "scheduled_task_skill_unavailable": return "A pinned Skill is not available to you. Remove it or choose another Skill.";
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

/**
 * Human copy for a pause or completion reason, an occurrence reason code or a
 * monitoring check outcome; unknown codes get a generic line.
 */
export function scheduledTaskReasonMessage(reasonCode: string | null): string | null {
  switch (reasonCode) {
    case null: return null;
    case "model_unavailable": return "The model is no longer available. Choose another model and resume.";
    case "search_unavailable": return "Web search is no longer available with this model. Turn it off or choose another model and resume.";
    case "provider_unavailable": return "The model's provider is unavailable right now. Check the model and resume.";
    case "tools_unavailable":
      return "The task's tools can no longer be used with this model. Turn tools off, choose another model, or switch some Skills or MCP tools off, then resume.";
    case "workspace_unavailable":
      return "Workspace can no longer be used for this task. Turn Workspace off or choose a model with tool support, then resume.";
    case "workspace_secret_limit": return "Your saved Workspace secrets exceed the limit. Remove some in Settings or turn Workspace off, then resume.";
    case "workspace_carryover_unavailable":
      return "The Workspace files of the task's previous chat could not be carried into its new chat, so nothing ran. " +
        "Open the task's chat to check its Workspace; the next run tries again.";
    case "skill_unavailable": return "A pinned Skill is no longer available. Edit the task's Skills, then resume.";
    case "source_unavailable":
      return `Paused after ${SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD} runs in a row could not reach a source the task uses. Reconnect it and resume.`;
    case "account_inactive": return "Paused while the account was not active. Resume to continue.";
    case "schedule_invalid": return "The schedule can no longer be calculated. Edit the schedule and resume.";
    case "repeated_failures": return "Paused after three failed runs in a row.";
    case "model_cannot_report": return "Monitoring needs a model that can use tools. Choose another model and resume.";
    case "verdict_missing": return "Paused after three checks in a row did not report whether anything changed. Resume to try again.";
    case "baseline": return "First check: the starting point later checks compare with.";
    case "update": return "Update: something changed since the last shown result.";
    case "no_update": return "No update: nothing changed since the last shown result.";
    case "goal_reached": return "Goal reached — task completed.";
    case "unreported": return "Shown: the check did not report whether anything changed.";
    case "could_not_check": return "Could not check: a source was unavailable.";
    case "missed": return "Skipped: the scheduled time passed while runs were unavailable.";
    case "previous_running": return "Skipped: the previous run was still in progress.";
    case "superseded": return "Skipped: a newer scheduled time arrived before this run could start.";
    case "chat_busy": return "Skipped: the task's chat was busy.";
    case "paused": return "Skipped: the task was paused.";
    case "admission_failed": return "The run could not start.";
    case "run_unavailable": return "The task's chat was deleted before the run finished.";
    case "model_run_cancelled": return "Stopped in the chat.";
    case "run_deadline": return `Stopped after running for ${SCHEDULED_TASK_RUN_DEADLINE_MINUTES} minutes.`;
    default: return "The run did not complete.";
  }
}

/**
 * Why a task paused with `skill_unavailable`, as a clause: the pinned Skills
 * that are no longer available by the names the owner may still see, and a
 * neutral clause when none of them can be named (gone, or no longer shared).
 */
export function scheduledTaskSkillUnavailableReason(task: Readonly<Pick<ScheduledTask, "pinnedSkills">>): string {
  const names = (task.pinnedSkills ?? []).flatMap((skill) => !skill.available && skill.name !== null ? [`“${skill.name}”`] : []);
  if (names.length === 0) return "a pinned Skill is no longer available";
  if (names.length === 1) return `the pinned Skill ${names[0]} is no longer available`;
  return `the pinned Skills ${names.slice(0, -1).join(", ")} and ${names.at(-1)} are no longer available`;
}

/**
 * What an answer's `manage_scheduled_task` call last did to a task: changed,

 * paused or resumed it, or proposed deleting it, which deletes nothing until
 * the owner confirms on the card. A card without one shows a task the
 * answer's `create_scheduled_task` call created.
 */
export type ScheduledTaskCardAction = "changed" | "paused" | "resumed" | "delete_proposed";
export const SCHEDULED_TASK_CARD_ACTIONS = [
  "changed", "paused", "resumed", "delete_proposed"
] as const satisfies readonly ScheduledTaskCardAction[];

/**
 * A scheduled task a chat answer created or managed through its tool calls
 * (`ThreadArtifactSummary.scheduledTasks`), with the answer's last `action` on
 * it. The answer's durable output keeps the task as that call left it; a
 * transcript read shows the owner's current task over it, or marks it
 * `deleted` once it is gone. `timeZoneFallback`: the answer's run had no
 * browser time zone, so a created task took UTC and the card names its zone.
 */
export type ScheduledTaskCard = Readonly<{
  taskId: string;
  title: string;
  kind: ScheduledTaskKind;
  schedule: ScheduledTaskSchedule;
  timeZone: string;
  timeZoneFallback: boolean;
  toolsEnabled: boolean;
  workspaceEnabled: boolean;
  status: ScheduledTaskStatus;
  /** Null unless active. */
  nextRunAt: string | null;
  action?: ScheduledTaskCardAction;
  deleted?: true;
}>;
/** Distinct tasks one chat answer may change, pause, resume or propose deleting. */
export const SCHEDULED_TASK_MANAGED_PER_ANSWER = 5;
/** Cards one answer may carry: the tasks it may manage and the one it may create. */
export const SCHEDULED_TASK_CARDS_LIMIT = SCHEDULED_TASK_MANAGED_PER_ANSWER + 1;

const CARD_KEYS = [
  "taskId", "title", "kind", "schedule", "timeZone", "timeZoneFallback", "toolsEnabled", "workspaceEnabled", "status",
  "nextRunAt"
] as const;
const CARD_ACTIONS: readonly unknown[] = SCHEDULED_TASK_CARD_ACTIONS;

export function decodeScheduledTaskCard(value: unknown): ScheduledTaskCard | null {
  if (!record(value) || !CARD_KEYS.every((key) => key in value) || !Object.keys(value).every((key) =>
    key === "action" || key === "deleted" || (CARD_KEYS as readonly string[]).includes(key))) return null;
  const schedule = decodeScheduledTaskSchedule(value.schedule);
  const title = normalizeScheduledTaskTitle(value.title);
  if (!schedule || !id(value.taskId) || !title || title !== value.title || !KINDS.includes(value.kind) ||
    !isScheduledTaskTimeZoneShape(value.timeZone) || typeof value.timeZoneFallback !== "boolean" ||
    typeof value.toolsEnabled !== "boolean" || typeof value.workspaceEnabled !== "boolean" ||
    !STATUSES.includes(value.status) || !nullable(value.nextRunAt, instant) ||
    (value.status !== "active" && value.nextRunAt !== null) || (value.action !== undefined && !CARD_ACTIONS.includes(value.action)) ||
    (value.deleted !== undefined && value.deleted !== true)) return null;
  return {
    taskId: value.taskId, title, kind: value.kind as ScheduledTaskKind, schedule, timeZone: value.timeZone,
    timeZoneFallback: value.timeZoneFallback, toolsEnabled: value.toolsEnabled, workspaceEnabled: value.workspaceEnabled,
    status: value.status as ScheduledTaskStatus, nextRunAt: value.nextRunAt,
    ...(value.action !== undefined ? { action: value.action as ScheduledTaskCardAction } : {}),
    ...(value.deleted ? { deleted: true as const } : {})
  };
}

/** The card of a task as the owner's store projects it now, with the answer's last action on it. */
export function scheduledTaskCard(
  task: Pick<ScheduledTask, "id" | "kind" | "nextRunAt" | "schedule" | "status" | "timeZone" | "title" | "toolsEnabled" |
    "workspaceEnabled">,
  timeZoneFallback: boolean,
  action?: ScheduledTaskCardAction
): ScheduledTaskCard {
  return {
    taskId: task.id, title: task.title, kind: task.kind, schedule: task.schedule, timeZone: task.timeZone, timeZoneFallback,
    toolsEnabled: task.toolsEnabled, workspaceEnabled: task.workspaceEnabled, status: task.status, nextRunAt: task.nextRunAt,
    ...(action ? { action } : {})
  };
}

/**
 * One card per task, in first-appearance order, the latest value winning: a
 * recovered answer may publish the same card again, and a later call on the
 * same task shows its newer state and action.
 */
export function foldScheduledTaskCards(values: readonly unknown[]): ScheduledTaskCard[] {
  const cards = new Map<string, ScheduledTaskCard>();
  for (const value of values) {
    const card = decodeScheduledTaskCard(value);
    if (card && (cards.has(card.taskId) || cards.size < SCHEDULED_TASK_CARDS_LIMIT)) cards.set(card.taskId, card);
  }
  return [...cards.values()];
}
