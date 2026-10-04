import type { Catalog, CatalogModel } from "@/lib/contracts/catalog";
import {
  SCHEDULED_TASK_ONCE_MIN_LEAD_MS,
  SCHEDULED_TASK_PROMPT_MAX_LENGTH,
  SCHEDULED_TASK_TITLE_MAX_LENGTH,
  SCHEDULED_TASK_WEEKDAYS,
  isScheduledTaskLocalDate,
  isScheduledTaskTime,
  type ScheduledTask,
  type ScheduledTaskChatMode,
  type ScheduledTaskDraft,
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

/**
 * "Weekdays" is a preset of the weekly schedule (Monday to Friday). Hourly
 * tasks are not offered here yet: an hourly task opens with an incomplete
 * schedule, so this editor never saves it as another kind.
 */
export type ScheduledTaskRepeat = "once" | "daily" | "weekdays" | "weekly" | "monthly" | "hourly";

export const SCHEDULED_TASK_REPEAT_OPTIONS: readonly Readonly<{ label: string; value: ScheduledTaskRepeat }>[] = [
  { label: "Once", value: "once" },
  { label: "Daily", value: "daily" },
  { label: "Weekdays", value: "weekdays" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" }
];

export type ScheduledTaskEditorDraft = Readonly<{
  title: string;
  prompt: string;
  repeat: ScheduledTaskRepeat;
  time: string;
  days: readonly ScheduledTaskWeekday[];
  dayOfMonth: number;
  date: string;
  timeZone: string;
  modelId: string;
  provider: string;
  searchEnabled: boolean;
  emailNotify: boolean;
  chatMode: ScheduledTaskChatMode;
  /** Carried unchanged until the editor offers a Type choice. */
  kind: ScheduledTaskKind;
}>;

export type ScheduledTaskFieldErrors = Partial<Record<
  "title" | "prompt" | "schedule" | "timeZone" | "model" | "search" | "form",
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

/** A new task: daily at 09:00 in the viewer's zone with the catalog's default model. */
export function blankScheduledTaskDraft(
  catalog: Catalog | null,
  timeZone: string,
  now: Date = new Date(),
  preset: Partial<ScheduledTaskEditorDraft> = {}
): ScheduledTaskEditorDraft {
  const today = scheduledTaskLocalDate(now, validScheduledTaskTimeZone(timeZone) ?? "UTC");
  const isoIndex = (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7;
  return {
    title: "",
    prompt: "",
    repeat: "daily",
    time: "09:00",
    days: [SCHEDULED_TASK_WEEKDAYS[isoIndex]!],
    dayOfMonth: today.day,
    date: tomorrow(timeZone, now),
    timeZone,
    ...defaultModel(catalog),
    searchEnabled: false,
    emailNotify: false,
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
  return {
    ...base,
    title: task.title,
    prompt: task.prompt,
    repeat,
    time: schedule.time,
    days: schedule.kind === "weekly" ? schedule.days : base.days,
    dayOfMonth: schedule.kind === "monthly" ? schedule.dayOfMonth : base.dayOfMonth,
    date: schedule.kind === "once" ? schedule.date : base.date,
    timeZone: task.timeZone,
    modelId: task.modelId,
    provider: task.provider,
    searchEnabled: task.searchEnabled,
    emailNotify: task.emailNotify,
    chatMode: task.chatMode,
    kind: task.kind
  };
}

/** The wire schedule for a draft, or null while it is incomplete. */
export function scheduledTaskDraftSchedule(draft: ScheduledTaskEditorDraft): ScheduledTaskSchedule | null {
  if (!isScheduledTaskTime(draft.time)) return null;
  switch (draft.repeat) {
    case "hourly": return null;
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

/**
 * Field errors the browser can tell before saving. The server stays the
 * authority; its codes map to the same fields.
 */
export function validateScheduledTaskDraft(
  draft: ScheduledTaskEditorDraft,
  catalog: Catalog | null,
  original: ScheduledTask | null,
  now: Date = new Date()
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
  if (!isScheduledTaskTime(draft.time)) errors.schedule = "Enter a time.";
  else if (draft.repeat === "weekly" && !draft.days.length) errors.schedule = "Choose at least one day.";
  else if (draft.repeat === "once") {
    if (!isScheduledTaskLocalDate(draft.date)) errors.schedule = "Choose a date.";
    else if (zone && scheduledTaskOnceInstant({ kind: "once", date: draft.date, time: draft.time }, zone).getTime() <=
      now.getTime() + SCHEDULED_TASK_ONCE_MIN_LEAD_MS && changedSchedule(draft, original)) {
      errors.schedule = "Choose a time at least a minute from now.";
    }
  }
  const model = catalogModel(catalog, draft);
  const keptModel = original && original.modelId === draft.modelId && original.provider === draft.provider;
  if (!draft.modelId || (!model && !keptModel)) errors.model = "Choose a model.";
  else if (!model) errors.model = "This model is no longer available to you. Choose another model.";
  else if (draft.searchEnabled && !modelHasSearch(catalog, model)) {
    errors.search = "Web search is not available with this model. Turn it off or choose another model.";
  }
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
    chatMode: draft.chatMode,
    kind: draft.kind
  } : null;
}

/** Only the changed fields, so an unchanged schedule keeps an active task's due run. */
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
  if (next.chatMode !== original.chatMode) patch.chatMode = next.chatMode;
  if (next.kind !== original.kind) patch.kind = next.kind;
  return patch;
}

export function sameScheduledTaskDraft(left: ScheduledTaskEditorDraft, right: ScheduledTaskEditorDraft): boolean {
  return left.title === right.title && left.prompt === right.prompt && left.repeat === right.repeat &&
    left.time === right.time && left.dayOfMonth === right.dayOfMonth && left.date === right.date &&
    left.timeZone === right.timeZone && left.modelId === right.modelId && left.provider === right.provider &&
    left.searchEnabled === right.searchEnabled && left.emailNotify === right.emailNotify && left.chatMode === right.chatMode &&
    left.kind === right.kind && scheduledTaskWeekdayMask(left.days) === scheduledTaskWeekdayMask(right.days);
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
    return draft.repeat === "weekly" && !draft.days.length ? "Choose at least one day to see the next run."
      : "Complete the schedule to see the next run.";
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
