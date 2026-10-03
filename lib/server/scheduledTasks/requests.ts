import {
  decodeScheduledTaskSchedule,
  isScheduledTaskModelIdentity,
  isScheduledTaskPrompt,
  normalizeScheduledTaskTitle,
  type ScheduledTaskDraft,
  type ScheduledTaskUpdateRequest
} from "../../contracts/scheduledTasks";
import { validScheduledTaskTimeZone, validateScheduledTaskSchedule } from "../../domain/scheduledTaskSchedule";

export type ScheduledTaskRequestFailure = {
  ok: false;
  code: "scheduled_task_invalid" | "scheduled_task_schedule_invalid" | "scheduled_task_time_zone_invalid";
};
export type ScheduledTaskRequestResult<T> = { ok: true; value: T } | ScheduledTaskRequestFailure;

const DRAFT_KEYS = ["title", "prompt", "schedule", "timeZone", "modelId", "provider", "searchEnabled", "emailNotify"];
const UPDATE_KEYS = [...DRAFT_KEYS, "expectedRevision", "status"];
const invalid: ScheduledTaskRequestFailure = { ok: false, code: "scheduled_task_invalid" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Create body: every editable field, nothing else. Shape and bounds fail as
 * `scheduled_task_invalid` before the schedule and then the zone are judged.
 */
export function decodeScheduledTaskCreateRequest(value: unknown): ScheduledTaskRequestResult<ScheduledTaskDraft> {
  if (!record(value) || Object.keys(value).length !== DRAFT_KEYS.length || !DRAFT_KEYS.every((key) => key in value)) {
    return invalid;
  }
  const title = normalizeScheduledTaskTitle(value.title);
  if (!title || !isScheduledTaskPrompt(value.prompt) || !isScheduledTaskModelIdentity(value.modelId) ||
    !isScheduledTaskModelIdentity(value.provider) || typeof value.searchEnabled !== "boolean" ||
    typeof value.emailNotify !== "boolean") return invalid;
  const schedule = validateScheduledTaskSchedule(value.schedule, value.timeZone);
  if (!schedule.ok) return schedule;
  return {
    ok: true,
    value: {
      title, prompt: value.prompt, schedule: schedule.schedule, timeZone: schedule.timeZone, modelId: value.modelId,
      provider: value.provider, searchEnabled: value.searchEnabled, emailNotify: value.emailNotify
    }
  };
}

/** Update body: `expectedRevision` plus at least one change; `modelId` and `provider` only together. */
export function decodeScheduledTaskUpdateRequest(value: unknown): ScheduledTaskRequestResult<ScheduledTaskUpdateRequest> {
  if (!record(value) || Object.keys(value).length < 2 || Object.keys(value).some((key) => !UPDATE_KEYS.includes(key)) ||
    typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 ||
    ("modelId" in value) !== ("provider" in value)) return invalid;
  const patch: ScheduledTaskUpdateRequest = { expectedRevision: value.expectedRevision };
  if ("title" in value) {
    const title = normalizeScheduledTaskTitle(value.title);
    if (!title) return invalid;
    patch.title = title;
  }
  if ("prompt" in value) {
    if (!isScheduledTaskPrompt(value.prompt)) return invalid;
    patch.prompt = value.prompt;
  }
  if ("modelId" in value) {
    if (!isScheduledTaskModelIdentity(value.modelId) || !isScheduledTaskModelIdentity(value.provider)) return invalid;
    patch.modelId = value.modelId;
    patch.provider = value.provider;
  }
  for (const key of ["searchEnabled", "emailNotify"] as const) {
    if (!(key in value)) continue;
    const flag = value[key];
    if (typeof flag !== "boolean") return invalid;
    patch[key] = flag;
  }
  if ("status" in value) {
    if (value.status !== "active" && value.status !== "paused") return invalid;
    patch.status = value.status;
  }
  if ("schedule" in value) {
    const schedule = decodeScheduledTaskSchedule(value.schedule);
    if (!schedule) return { ok: false, code: "scheduled_task_schedule_invalid" };
    patch.schedule = schedule;
  }
  if ("timeZone" in value) {
    const timeZone = validScheduledTaskTimeZone(value.timeZone);
    if (!timeZone) return { ok: false, code: "scheduled_task_time_zone_invalid" };
    patch.timeZone = timeZone;
  }
  return { ok: true, value: patch };
}
