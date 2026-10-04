import type { Catalog, CatalogModel } from "@/lib/contracts/catalog";
import type { WorkspaceUnavailableReason } from "@/lib/contracts/workspace";
import {
  SCHEDULED_TASK_EVERY_HOURS,
  SCHEDULED_TASK_ONCE_MIN_LEAD_MS,
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  SCHEDULED_TASK_WEEKDAYS,
  isScheduledTaskLocalDate,
  isScheduledTaskTime,
  scheduledTaskErrorMessage,
  scheduledTaskToolDefaults,
  type ScheduledTask,
  type ScheduledTaskChatMode,
  type ScheduledTaskDraft,
  type ScheduledTaskEveryHours,
  type ScheduledTaskKind,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpdateRequest,
  type ScheduledTaskWeekday
} from "@/lib/contracts/scheduledTasks";
import {
  nextOccurrenceAfter,
  sameScheduledTaskSchedule,
  scheduledTaskLocalDate,
  scheduledTaskOnceInstant,
  scheduledTaskWeekdayMask,
  validScheduledTaskTimeZone
} from "@/lib/domain/scheduledTaskSchedule";
import { WORKDAYS, formatScheduledInstant } from "./scheduledTaskPresentation";

/** "Weekdays" is a preset of the weekly schedule (Monday to Friday). */
export type ScheduledTaskRepeat = "once" | "daily" | "weekdays" | "weekly" | "monthly" | "hourly";

export const SCHEDULED_TASK_REPEAT_OPTIONS: readonly Readonly<{ label: string; value: ScheduledTaskRepeat }>[] = [
  { label: "Once", value: "once" },
  { label: "Every few hours", value: "hourly" },
  { label: "Daily", value: "daily" },
  { label: "Weekdays", value: "weekdays" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" }
];

export const SCHEDULED_TASK_EVERY_HOURS_OPTIONS: readonly Readonly<{ label: string; value: ScheduledTaskEveryHours }>[] =
  SCHEDULED_TASK_EVERY_HOURS.map((value) => ({ label: value === 1 ? "Every hour" : `Every ${value} hours`, value }));

export const SCHEDULED_TASK_KIND_OPTIONS: readonly Readonly<{ label: string; value: ScheduledTaskKind }>[] = [
  { label: "Regular", value: "standard" },
  { label: "Monitoring", value: "monitoring" }
];

/**
 * Whether the installation offers Workspace, as the shell's `/api/workspace`
 * read reports it; `unknown` while it loads or after it failed. Only a
 * Workspace the administrator turned off refuses a save: a runtime that is
 * down for now does not, its runs retry.
 */
export type ScheduledTaskWorkspaceAvailability = "available" | "installation_disabled" | "runtime_unavailable" | "unknown";

/**
 * The installation's part of the composer's Workspace state: its own
 * reason, not the composer model's (the task has its own model).
 */
export function scheduledTaskWorkspaceAvailability(workspace: Readonly<{
  available: boolean;
  loading: boolean;
  unavailableReason?: WorkspaceUnavailableReason;
}>): ScheduledTaskWorkspaceAvailability {
  if (workspace.loading) return "unknown";
  if (workspace.available || workspace.unavailableReason === "model_tools_required") return "available";
  return workspace.unavailableReason ?? "unknown";
}

/** An hourly schedule runs all day, or from a start time until an optional end time. */
export type ScheduledTaskHourlyWindow = "all_day" | "hours";

export type ScheduledTaskEditorDraft = Readonly<{
  title: string;
  prompt: string;
  repeat: ScheduledTaskRepeat;
  /** The run time, or the start of an hourly window. */
  time: string;
  /** Weekly days. */
  days: readonly ScheduledTaskWeekday[];
  everyHours: ScheduledTaskEveryHours;
  hourlyWindow: ScheduledTaskHourlyWindow;
  /** The inclusive end of an hourly window; empty runs through the end of the day. */
  until: string;
  hourlyDays: readonly ScheduledTaskWeekday[];
  dayOfMonth: number;
  date: string;
  timeZone: string;
  modelId: string;
  provider: string;
  searchEnabled: boolean;
  emailNotify: boolean;
  /** MCP tools and Skills; a new task starts from the composer defaults. */
  toolsEnabled: boolean;
  workspaceEnabled: boolean;
  /** The owner's choice for other schedules; hourly and monitoring tasks always continue in one chat. */
  chatMode: ScheduledTaskChatMode;
  kind: ScheduledTaskKind;
}>;

export type ScheduledTaskFieldErrors = Partial<Record<
  "title" | "prompt" | "kind" | "schedule" | "timeZone" | "model" | "search" | "tools" | "workspace" | "chatMode" | "form",
  string
>>;

export function modelKey(model: Readonly<{ modelId: string; provider: string }>): string {
  return `${model.provider}:${model.modelId}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDateText(date: Readonly<{ year: number; month: number; day: number }>): string {
  return `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;
}

/** Today's date in a zone as "YYYY-MM-DD". */
export function scheduledTaskToday(timeZone: string, now: Date = new Date()): string {
  return localDateText(scheduledTaskLocalDate(now, validScheduledTaskTimeZone(timeZone) ?? "UTC"));
}

function tomorrow(timeZone: string, now: Date): string {
  return scheduledTaskToday(timeZone, new Date(now.getTime() + 86_400_000));
}

function defaultModel(catalog: Catalog | null): Readonly<{ modelId: string; provider: string }> {
  const models = catalog?.models ?? [];
  const preferred = catalog
    ? models.find((model) => model.modelId === catalog.defaults.modelId && model.provider === catalog.defaults.provider)
    : undefined;
  const model = preferred ?? models[0];
  return model ? { modelId: model.modelId, provider: model.provider } : { modelId: "", provider: "" };
}

/**
 * The tool switches a new task starts with: the owner's composer defaults,
 * both off for a model without tool calling and Workspace off while the
 * administrator has it turned off.
 */
export function scheduledTaskStartingTools(
  catalog: Catalog | null,
  model: Readonly<{ modelId: string; provider: string }>,
  workspace: ScheduledTaskWorkspaceAvailability = "unknown"
): Pick<ScheduledTaskEditorDraft, "toolsEnabled" | "workspaceEnabled"> {
  if (!catalog || !modelCanUseTools(catalogModel(catalog, model))) return { toolsEnabled: false, workspaceEnabled: false };
  const defaults = scheduledTaskToolDefaults(catalog.defaults);
  return { toolsEnabled: defaults.toolsEnabled, workspaceEnabled: defaults.workspaceEnabled && workspace !== "installation_disabled" };
}

/** A new task: daily at 09:00 in the viewer's zone with the catalog's default model, a new chat per run. */
export function blankScheduledTaskDraft(
  catalog: Catalog | null,
  timeZone: string,
  now: Date = new Date(),
  preset: Partial<ScheduledTaskEditorDraft> = {},
  workspace: ScheduledTaskWorkspaceAvailability = "unknown"
): ScheduledTaskEditorDraft {
  const today = scheduledTaskLocalDate(now, validScheduledTaskTimeZone(timeZone) ?? "UTC");
  const isoIndex = (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7;
  const model = defaultModel(catalog);
  return {
    title: "",
    prompt: "",
    repeat: "daily",
    time: "09:00",
    days: [SCHEDULED_TASK_WEEKDAYS[isoIndex]!],
    everyHours: 1,
    hourlyWindow: "all_day",
    until: "18:00",
    hourlyDays: [...SCHEDULED_TASK_WEEKDAYS],
    dayOfMonth: today.day,
    date: tomorrow(timeZone, now),
    timeZone,
    ...model,
    searchEnabled: false,
    emailNotify: false,
    ...scheduledTaskStartingTools(catalog, model, workspace),
    chatMode: "new",
    kind: "standard",
    ...preset
  };
}

export function scheduledTaskDraftFromTask(task: ScheduledTask, now: Date = new Date()): ScheduledTaskEditorDraft {
  const base = blankScheduledTaskDraft(null, task.timeZone, now);
  const schedule = task.schedule;
  const repeat: ScheduledTaskRepeat = schedule.kind === "weekly"
    ? scheduledTaskWeekdayMask(schedule.days) === scheduledTaskWeekdayMask(WORKDAYS) ? "weekdays" : "weekly"
    : schedule.kind;
  const hourly = schedule.kind === "hourly" ? schedule : null;
  const hourlyWindow: ScheduledTaskHourlyWindow = hourly && (hourly.time !== "00:00" || hourly.until !== null) ? "hours" : "all_day";
  return {
    ...base,
    title: task.title,
    prompt: task.prompt,
    repeat,
    // An all-day hourly schedule starts at midnight; another kind chosen later starts from the default time.
    time: hourly && hourlyWindow === "all_day" ? base.time : schedule.time,
    days: schedule.kind === "weekly" ? schedule.days : base.days,
    everyHours: hourly?.everyHours ?? base.everyHours,
    hourlyWindow,
    until: !hourly ? base.until : hourly.until ?? (hourlyWindow === "hours" ? "" : base.until),
    hourlyDays: hourly?.days ?? base.hourlyDays,
    dayOfMonth: schedule.kind === "monthly" ? schedule.dayOfMonth : base.dayOfMonth,
    date: schedule.kind === "once" ? schedule.date : base.date,
    timeZone: task.timeZone,
    modelId: task.modelId,
    provider: task.provider,
    searchEnabled: task.searchEnabled,
    emailNotify: task.emailNotify,
    toolsEnabled: task.toolsEnabled,
    workspaceEnabled: task.workspaceEnabled,
    chatMode: task.chatMode,
    kind: task.kind
  };
}

/** What keeps an hourly draft from decoding, in the decoder's terms; null when it is complete. */
function hourlyScheduleError(draft: ScheduledTaskEditorDraft): string | null {
  if (!draft.hourlyDays.length) return "Choose at least one day.";
  if (draft.hourlyWindow === "all_day") return null;
  if (!isScheduledTaskTime(draft.time)) return "Enter a start time.";
  if (draft.until && !isScheduledTaskTime(draft.until)) return "Enter an end time.";
  // "HH:MM" strings compare in time order.
  if (draft.until && draft.until <= draft.time) return "Choose an end time later than the start time.";
  return null;
}

/** The wire schedule for a draft, or null while it is incomplete. */
export function scheduledTaskDraftSchedule(draft: ScheduledTaskEditorDraft): ScheduledTaskSchedule | null {
  if (draft.repeat === "hourly") {
    if (hourlyScheduleError(draft)) return null;
    const days = SCHEDULED_TASK_WEEKDAYS.filter((day) => draft.hourlyDays.includes(day));
    return draft.hourlyWindow === "all_day"
      ? { kind: "hourly", everyHours: draft.everyHours, time: "00:00", until: null, days }
      : { kind: "hourly", everyHours: draft.everyHours, time: draft.time, until: draft.until || null, days };
  }
  if (!isScheduledTaskTime(draft.time)) return null;
  switch (draft.repeat) {
    case "once": return isScheduledTaskLocalDate(draft.date) ? { kind: "once", date: draft.date, time: draft.time } : null;
    case "daily": return { kind: "daily", time: draft.time };
    case "weekdays": return { kind: "weekly", time: draft.time, days: [...WORKDAYS] };
    case "weekly": {
      const days = SCHEDULED_TASK_WEEKDAYS.filter((day) => draft.days.includes(day));
      return days.length ? { kind: "weekly", time: draft.time, days } : null;
    }
    case "monthly":
      return Number.isInteger(draft.dayOfMonth) && draft.dayOfMonth >= 1 && draft.dayOfMonth <= 31
        ? { kind: "monthly", time: draft.time, dayOfMonth: draft.dayOfMonth } : null;
  }
}

/** Why the chat choice is fixed to the task's own chat, or null when the owner chooses. */
export function scheduledTaskForcedChatReason(draft: Pick<ScheduledTaskEditorDraft, "kind" | "repeat">): string | null {
  if (draft.kind === "monitoring") return "Monitoring compares each check with the last result, so it always continues in one chat.";
  return draft.repeat === "hourly" ? "Hourly tasks always continue in one chat." : null;
}

/**
 * The chat mode a save sends: hourly schedules and monitoring tasks always
 * continue in one chat; the draft keeps the owner's own choice for later.
 */
export function scheduledTaskDraftChatMode(draft: Pick<ScheduledTaskEditorDraft, "chatMode" | "kind" | "repeat">): ScheduledTaskChatMode {
  return scheduledTaskForcedChatReason(draft) ? "same" : draft.chatMode;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

export function modelHasSearch(catalog: Catalog | null, model: CatalogModel | undefined): boolean {
  if (!catalog || !model) return false;
  const concrete = new Set(catalog.searchStrategies.filter((option) => option.kind !== "none").map((option) => option.strategyId));
  return model.searchStrategyIds.some((id) => concrete.has(id));
}

export function catalogModel(catalog: Catalog | null, draft: Pick<ScheduledTaskEditorDraft, "modelId" | "provider">): CatalogModel | undefined {
  return catalog?.models.find((model) => model.modelId === draft.modelId && model.provider === draft.provider);
}

export function modelCanUseTools(model: CatalogModel | undefined): boolean {
  return model?.capabilities.toolCalling === true;
}

/**
 * Why the task's model or installation keeps a capability from this task, as
 * the server would refuse it; null when it is available or the model is not
 * known (the model field then carries the error).
 */
export type ScheduledTaskCapabilityBlockers = Readonly<{ monitoring: string | null; tools: string | null; workspace: string | null }>;

export function scheduledTaskCapabilityBlockers(
  catalog: Catalog | null,
  draft: Pick<ScheduledTaskEditorDraft, "modelId" | "provider">,
  workspace: ScheduledTaskWorkspaceAvailability
): ScheduledTaskCapabilityBlockers {
  const model = catalogModel(catalog, draft);
  const noTools = Boolean(model) && !modelCanUseTools(model);
  return {
    monitoring: noTools ? scheduledTaskErrorMessage("scheduled_task_model_cannot_report") : null,
    tools: noTools ? "Not available with this model." : null,
    workspace: noTools ? "Not available with this model."
      : workspace === "installation_disabled" ? "Workspace is turned off by the administrator." : null
  };
}

function scheduleError(draft: ScheduledTaskEditorDraft, zone: string | null, original: ScheduledTask | null, now: Date): string | null {
  if (draft.repeat === "hourly") return hourlyScheduleError(draft);
  if (!isScheduledTaskTime(draft.time)) return "Enter a time.";
  if (draft.repeat === "weekly" && !draft.days.length) return "Choose at least one day.";
  if (draft.repeat !== "once") return null;
  if (!isScheduledTaskLocalDate(draft.date)) return "Choose a date.";
  return zone && scheduledTaskOnceInstant({ kind: "once", date: draft.date, time: draft.time }, zone).getTime() <=
    now.getTime() + SCHEDULED_TASK_ONCE_MIN_LEAD_MS && changedSchedule(draft, original)
    ? "Choose a time at least a minute from now." : null;
}

/**
 * Field errors the browser can tell before saving. The server stays the
 * authority; its codes map to the same fields.
 */
export function validateScheduledTaskDraft(
  draft: ScheduledTaskEditorDraft,
  catalog: Catalog | null,
  original: ScheduledTask | null,
  now: Date = new Date(),
  workspace: ScheduledTaskWorkspaceAvailability = "unknown"
): ScheduledTaskFieldErrors {
  const errors: ScheduledTaskFieldErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = "Enter a name.";
  else if (codePoints(title) > SCHEDULED_TASK_TITLE_MAX_LENGTH) errors.title = `Use up to ${SCHEDULED_TASK_TITLE_MAX_LENGTH} characters.`;
  if (!draft.prompt.trim()) errors.prompt = "Enter the instructions.";
  else if (codePoints(draft.prompt) > SCHEDULED_TASK_PROMPT_MAX_LENGTH) {
    errors.prompt = `Shorten the instructions to ${SCHEDULED_TASK_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters.`;
  }
  const zone = validScheduledTaskTimeZone(draft.timeZone);
  if (!zone) errors.timeZone = "Choose a time zone.";
  const schedule = scheduleError(draft, zone, original, now);
  if (schedule) errors.schedule = schedule;
  const model = catalogModel(catalog, draft);
  const keptModel = original && original.modelId === draft.modelId && original.provider === draft.provider;
  if (!draft.modelId || (!model && !keptModel)) errors.model = "Choose a model.";
  else if (!model) errors.model = "This model is no longer available to you. Choose another model.";
  else if (draft.searchEnabled && !modelHasSearch(catalog, model)) {
    errors.search = "Web search is not available with this model. Turn it off or choose another model.";
  }
  const blockers = scheduledTaskCapabilityBlockers(catalog, draft, workspace);
  if (draft.kind === "monitoring" && blockers.monitoring) errors.kind = blockers.monitoring;
  if (draft.toolsEnabled && blockers.tools) errors.tools = scheduledTaskErrorMessage("scheduled_task_tools_unavailable");
  if (draft.workspaceEnabled && blockers.workspace) errors.workspace = scheduledTaskErrorMessage("scheduled_task_workspace_unavailable");
  return errors;
}

/** A new task, or an edit whose schedule or zone differs: the server then requires a future once time. */
function changedSchedule(draft: ScheduledTaskEditorDraft, original: ScheduledTask | null): boolean {
  if (!original) return true;
  const schedule = scheduledTaskDraftSchedule(draft);
  return !schedule || !sameScheduledTaskSchedule(schedule, original.schedule) || draft.timeZone !== original.timeZone;
}

export function scheduledTaskCreateRequest(draft: ScheduledTaskEditorDraft): ScheduledTaskDraft | null {
  const schedule = scheduledTaskDraftSchedule(draft);
  return schedule ? {
    title: draft.title.trim(),
    prompt: draft.prompt,
    schedule,
    timeZone: draft.timeZone,
    modelId: draft.modelId,
    provider: draft.provider,
    searchEnabled: draft.searchEnabled,
    emailNotify: draft.emailNotify,
    toolsEnabled: draft.toolsEnabled,
    workspaceEnabled: draft.workspaceEnabled,
    chatMode: scheduledTaskDraftChatMode(draft),
    kind: draft.kind
  } : null;
}

/**
 * Only the changed fields, so an unchanged schedule keeps an active task's due
 * run. A switch to an hourly schedule or to monitoring carries
 * `chatMode: "same"` with it.
 */
export function scheduledTaskUpdateRequest(draft: ScheduledTaskEditorDraft, original: ScheduledTask): ScheduledTaskUpdateRequest | null {
  const next = scheduledTaskCreateRequest(draft);
  if (!next) return null;
  const patch: ScheduledTaskUpdateRequest = { expectedRevision: original.revision };
  if (next.title !== original.title) patch.title = next.title;
  if (next.prompt !== original.prompt) patch.prompt = next.prompt;
  if (!sameScheduledTaskSchedule(next.schedule, original.schedule)) patch.schedule = next.schedule;
  if (next.timeZone !== original.timeZone) patch.timeZone = next.timeZone;
  if (next.modelId !== original.modelId || next.provider !== original.provider) {
    patch.modelId = next.modelId;
    patch.provider = next.provider;
  }
  if (next.searchEnabled !== original.searchEnabled) patch.searchEnabled = next.searchEnabled;
  if (next.emailNotify !== original.emailNotify) patch.emailNotify = next.emailNotify;
  if (next.toolsEnabled !== original.toolsEnabled) patch.toolsEnabled = next.toolsEnabled;
  if (next.workspaceEnabled !== original.workspaceEnabled) patch.workspaceEnabled = next.workspaceEnabled;
  if (next.chatMode !== original.chatMode) patch.chatMode = next.chatMode;
  if (next.kind !== original.kind) patch.kind = next.kind;
  return patch;
}

export function sameScheduledTaskDraft(left: ScheduledTaskEditorDraft, right: ScheduledTaskEditorDraft): boolean {
  return left.title === right.title && left.prompt === right.prompt && left.repeat === right.repeat &&
    left.time === right.time && left.dayOfMonth === right.dayOfMonth && left.date === right.date &&
    left.timeZone === right.timeZone && left.modelId === right.modelId && left.provider === right.provider &&
    left.searchEnabled === right.searchEnabled && left.emailNotify === right.emailNotify && left.chatMode === right.chatMode &&
    left.everyHours === right.everyHours && left.hourlyWindow === right.hourlyWindow && left.until === right.until &&
    left.toolsEnabled === right.toolsEnabled && left.workspaceEnabled === right.workspaceEnabled && left.kind === right.kind &&
    scheduledTaskWeekdayMask(left.days) === scheduledTaskWeekdayMask(right.days) &&
    scheduledTaskWeekdayMask(left.hourlyDays) === scheduledTaskWeekdayMask(right.hourlyDays);
}

/** The footer's live sentence about when the saved task will run next. */
export function scheduledTaskPreview(
  draft: ScheduledTaskEditorDraft,
  original: ScheduledTask | null,
  now: Date = new Date()
): string {
  const zone = validScheduledTaskTimeZone(draft.timeZone);
  const schedule = scheduledTaskDraftSchedule(draft);
  if (!zone) return "Choose a time zone to see the next run.";
  if (!schedule) {
    const noDays = draft.repeat === "weekly" ? !draft.days.length : draft.repeat === "hourly" && !draft.hourlyDays.length;
    return noDays ? "Choose at least one day to see the next run." : "Complete the schedule to see the next run.";
  }
  const changed = !original || !sameScheduledTaskSchedule(schedule, original.schedule) || zone !== original.timeZone;
  if (original?.status === "completed" && !changed) return "Completed. Change the schedule to run it again.";
  if (original?.status === "active" && !changed && original.nextRunAt) {
    return `Next run: ${formatScheduledInstant(original.nextRunAt, zone, now)}`;
  }
  const next = nextOccurrenceAfter(schedule, zone, new Date(now.getTime() + (schedule.kind === "once" ? SCHEDULED_TASK_ONCE_MIN_LEAD_MS : 0)));
  if (!next) return "This time has passed. Choose a later date or time.";
  const when = formatScheduledInstant(next, zone, now);
  return original?.status === "paused" ? `Paused. After you resume, it runs next ${when}.` : `Next run: ${when}`;
}
