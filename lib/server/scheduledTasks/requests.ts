import {
  SCHEDULED_TASK_CHAT_MODES,
  SCHEDULED_TASK_DEFAULT_HISTORY_RETENTION_DAYS,
  SCHEDULED_TASK_KINDS,
  decodeScheduledTaskPinnedSkillIds,
  isScheduledTaskHistoryRetentionDays,
  decodeScheduledTaskSchedule,
  isScheduledTaskModelIdentity,
  isScheduledTaskPrompt,
  normalizeScheduledTaskTitle,
  scheduledTaskChatModeAllowed,
  type ScheduledTaskChatMode,
  type ScheduledTaskDraft,
  type ScheduledTaskKind,
  type ScheduledTaskUpdateRequest
} from "../../contracts/scheduledTasks";
import { validScheduledTaskTimeZone, validateScheduledTaskSchedule } from "../../domain/scheduledTaskSchedule";

export type ScheduledTaskRequestFailure = {
  ok: false;
  code: "scheduled_task_invalid" | "scheduled_task_schedule_invalid" | "scheduled_task_time_zone_invalid" |
    "scheduled_task_chat_mode_invalid" | "scheduled_task_skills_need_tools";
};

export type ScheduledTaskRequestResult<T> = { ok: true; value: T } | ScheduledTaskRequestFailure;

const DRAFT_KEYS = [
  "title", "prompt", "schedule", "timeZone", "modelId", "provider", "searchEnabled", "emailNotify", "toolsEnabled",
  "workspaceEnabled", "memoryEnabled", "chatMode", "kind"
];
/** Draft fields a create body may leave out, with their default. */
const OPTIONAL_DRAFT_KEYS = ["pinnedSkillIds", "historyRetentionDays"];
const UPDATE_KEYS = [...DRAFT_KEYS, ...OPTIONAL_DRAFT_KEYS, "expectedRevision", "status"];
const invalid: ScheduledTaskRequestFailure = { ok: false, code: "scheduled_task_invalid" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function chatMode(value: unknown): value is ScheduledTaskChatMode {
  return (SCHEDULED_TASK_CHAT_MODES as readonly unknown[]).includes(value);
}

function taskKind(value: unknown): value is ScheduledTaskKind {
  return (SCHEDULED_TASK_KINDS as readonly unknown[]).includes(value);
}

/**
 * Create body: every editable field, nothing else; `pinnedSkillIds` may be
 * left out (none), and so may `historyRetentionDays` (a new task keeps 90
 * days of old chats). Shape and bounds fail as `scheduled_task_invalid` before
 * the schedule, then the zone, then a chat mode the schedule or type does not
 * allow, then pins without tools are judged.
 */
export function decodeScheduledTaskCreateRequest(value: unknown): ScheduledTaskRequestResult<ScheduledTaskDraft> {
  if (!record(value) || !DRAFT_KEYS.every((key) => key in value) ||
    Object.keys(value).some((key) => !DRAFT_KEYS.includes(key) && !OPTIONAL_DRAFT_KEYS.includes(key))) {
    return invalid;
  }
  const pinnedSkillIds = value.pinnedSkillIds === undefined ? [] : decodeScheduledTaskPinnedSkillIds(value.pinnedSkillIds);
  if (!pinnedSkillIds) return invalid;
  const historyRetentionDays = value.historyRetentionDays === undefined
    ? SCHEDULED_TASK_DEFAULT_HISTORY_RETENTION_DAYS : value.historyRetentionDays;
  if (!isScheduledTaskHistoryRetentionDays(historyRetentionDays)) return invalid;
  const title = normalizeScheduledTaskTitle(value.title);
  if (!title || !isScheduledTaskPrompt(value.prompt) || !isScheduledTaskModelIdentity(value.modelId) ||
    !isScheduledTaskModelIdentity(value.provider) || typeof value.searchEnabled !== "boolean" ||
    typeof value.emailNotify !== "boolean" || typeof value.toolsEnabled !== "boolean" ||
    typeof value.workspaceEnabled !== "boolean" || typeof value.memoryEnabled !== "boolean" || !chatMode(value.chatMode) ||
    !taskKind(value.kind)) return invalid;
  const schedule = validateScheduledTaskSchedule(value.schedule, value.timeZone);
  if (!schedule.ok) return schedule;
  if (!scheduledTaskChatModeAllowed({ kind: value.kind, schedule: schedule.schedule }, value.chatMode)) {
    return { ok: false, code: "scheduled_task_chat_mode_invalid" };
  }
  if (pinnedSkillIds.length > 0 && !value.toolsEnabled) return { ok: false, code: "scheduled_task_skills_need_tools" };
  return {
    ok: true,
    value: {
      title, prompt: value.prompt, schedule: schedule.schedule, timeZone: schedule.timeZone, modelId: value.modelId,
      provider: value.provider, searchEnabled: value.searchEnabled, emailNotify: value.emailNotify,
      toolsEnabled: value.toolsEnabled, workspaceEnabled: value.workspaceEnabled, memoryEnabled: value.memoryEnabled,
      pinnedSkillIds, chatMode: value.chatMode, kind: value.kind, historyRetentionDays
    }
  };
}

/**
 * Update body: `expectedRevision` plus at least one change; `modelId` and
 * `provider` only together. Whether the resulting chat mode suits the
 * resulting schedule and type is judged against the stored task.
 */
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
  for (const key of ["searchEnabled", "emailNotify", "toolsEnabled", "workspaceEnabled", "memoryEnabled"] as const) {
    if (!(key in value)) continue;
    const flag = value[key];
    if (typeof flag !== "boolean") return invalid;
    patch[key] = flag;
  }
  if ("pinnedSkillIds" in value) {
    const pinnedSkillIds = decodeScheduledTaskPinnedSkillIds(value.pinnedSkillIds);
    if (!pinnedSkillIds) return invalid;
    patch.pinnedSkillIds = pinnedSkillIds;
  }
  if ("chatMode" in value) {
    if (!chatMode(value.chatMode)) return invalid;
    patch.chatMode = value.chatMode;
  }
  if ("kind" in value) {
    if (!taskKind(value.kind)) return invalid;
    patch.kind = value.kind;
  }
  if ("historyRetentionDays" in value) {
    if (!isScheduledTaskHistoryRetentionDays(value.historyRetentionDays)) return invalid;
    patch.historyRetentionDays = value.historyRetentionDays;
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
