import {
  SCHEDULED_TASK_ONCE_MIN_LEAD_MS,
  scheduledTaskChatModeAllowed,
  type ScheduledTask,
  type ScheduledTaskDraft,
  type ScheduledTaskSchedule,
  type ScheduledTaskStatus,
  type ScheduledTaskUpdateRequest
} from "../../contracts/scheduledTasks";
import { nextOccurrenceAfter, sameScheduledTaskSchedule } from "../../domain/scheduledTaskSchedule";

export type ScheduledTaskPlanFailure = {
  ok: false;
  code: "scheduled_task_once_in_past" | "scheduled_task_schedule_invalid" | "scheduled_task_chat_mode_invalid";
};
export type ScheduledTaskUpdatePlan = {
  ok: true;
  draft: ScheduledTaskDraft;
  status: ScheduledTaskStatus;
  /** Undefined keeps the stored due time. */
  nextRunAt: Date | null | undefined;
  /** The model identity (and its tool calling for monitoring) must be readmitted against the current catalog. */
  checkModel: boolean;
};

/**
 * The first due instant when a task is armed at `now`, without catch-up. A
 * once task must lie beyond the minimum lead.
 */
export function firstScheduledTaskRunAt(
  schedule: ScheduledTaskSchedule,
  timeZone: string,
  now: Date
): { ok: true; nextRunAt: Date } | ScheduledTaskPlanFailure {
  const after = schedule.kind === "once" ? new Date(now.getTime() + SCHEDULED_TASK_ONCE_MIN_LEAD_MS) : now;
  const nextRunAt = nextOccurrenceAfter(schedule, timeZone, after);
  if (nextRunAt) return { ok: true, nextRunAt };
  return { ok: false, code: schedule.kind === "once" ? "scheduled_task_once_in_past" : "scheduled_task_schedule_invalid" };
}

/**
 * Owner edit rules. Explicit status wins; otherwise the status is kept, except
 * that a schedule change reactivates a completed task. Pausing clears the
 * due time. Arming (resume, reactivation or a changed active schedule) takes
 * the next occurrence from now; an unchanged active schedule keeps its due time
 * so that an edit never skips a run that is already due. A changed once
 * schedule must lie ahead in any status. The model is readmitted whenever the
 * result is active or its identity, Search or type changed. An hourly or
 * monitoring result must continue in one chat; the chat mode is never changed
 * silently.
 */
export function planScheduledTaskUpdate(
  current: ScheduledTask,
  patch: ScheduledTaskUpdateRequest,
  now: Date
): ScheduledTaskUpdatePlan | ScheduledTaskPlanFailure {
  const draft: ScheduledTaskDraft = {
    title: patch.title ?? current.title,
    prompt: patch.prompt ?? current.prompt,
    schedule: patch.schedule ?? current.schedule,
    timeZone: patch.timeZone ?? current.timeZone,
    modelId: patch.modelId ?? current.modelId,
    provider: patch.provider ?? current.provider,
    searchEnabled: patch.searchEnabled ?? current.searchEnabled,
    emailNotify: patch.emailNotify ?? current.emailNotify,
    chatMode: patch.chatMode ?? current.chatMode,
    kind: patch.kind ?? current.kind
  };
  if (!scheduledTaskChatModeAllowed(draft, draft.chatMode)) return { ok: false, code: "scheduled_task_chat_mode_invalid" };
  const scheduleChanged = draft.timeZone !== current.timeZone || !sameScheduledTaskSchedule(draft.schedule, current.schedule);
  const modelChanged = draft.modelId !== current.modelId || draft.provider !== current.provider ||
    draft.searchEnabled !== current.searchEnabled || draft.kind !== current.kind;
  const status = patch.status ?? (current.status === "completed" && scheduleChanged ? "active" : current.status);
  // A claimed once task has no due time left to keep; a recurring one always needs one.
  const keepsDueTime = current.status === "active" && !scheduleChanged &&
    (current.nextRunAt !== null || draft.schedule.kind === "once");
  const arming = status === "active" && !keepsDueTime;
  let first: Date | null = null;
  if (arming || (scheduleChanged && draft.schedule.kind === "once")) {
    const planned = firstScheduledTaskRunAt(draft.schedule, draft.timeZone, now);
    if (!planned.ok) return planned;
    first = planned.nextRunAt;
  }
  return {
    ok: true, draft, status,
    nextRunAt: status !== "active" ? null : arming ? first : undefined,
    checkModel: status === "active" || modelChanged
  };
}
