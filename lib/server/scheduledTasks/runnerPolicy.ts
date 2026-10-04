import type { ScheduledTaskRunTrigger, ScheduledTaskSchedule } from "../../contracts/scheduledTasks";
import { nextOccurrenceAfter } from "../../domain/scheduledTaskSchedule";

/**
 * Occurrence policy of the scheduled task runner, free of I/O. The Prisma
 * store applies these decisions under row locks; tests drive them directly.
 */

/** A scheduled instant later than this is recorded as missed instead of run. */
export const SCHEDULED_TASK_LATENESS_MS = 12 * 60 * 60 * 1000;
/** Busy-chat retries and interrupted admissions continue this long after the first attempt. */
export const SCHEDULED_TASK_RETRY_WINDOW_MS = 30 * 60 * 1000;
/** One admission attempt owns its occurrence this long. */
export const SCHEDULED_TASK_ADMISSION_LEASE_MS = 5 * 60 * 1000;
export const SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD = 3;
/** Newest occurrences kept per task. */
export const SCHEDULED_TASK_OCCURRENCE_RETENTION = 50;
/** Scheduled runs executing installation-wide and per owner; a run counts until it is terminal. */
export const SCHEDULED_TASK_MAX_EXECUTING = 5;
export const SCHEDULED_TASK_MAX_EXECUTING_PER_USER = 1;

export type ScheduledTaskStatusColumn = "ACTIVE" | "PAUSED" | "COMPLETED";
export type ScheduledTaskSettledState = "COMPLETED" | "FAILED" | "SKIPPED";
/** Stable codes of automatic pauses. */
export type ScheduledTaskPauseReason =
  | "account_inactive" | "model_unavailable" | "provider_unavailable" | "repeated_failures" | "schedule_invalid"
  | "search_unavailable";

export type ScheduledTaskOutcome = Readonly<{
  state: ScheduledTaskSettledState;
  reasonCode: string | null;
  /** A permanent admission refusal that pauses a scheduled (not manual) task. */
  pauseReason?: ScheduledTaskPauseReason;
}>;

export type ScheduledTaskClaimPlan = Readonly<{
  occurrences: readonly Readonly<{ scheduledFor: Date; missed: boolean }>[];
  status: ScheduledTaskStatusColumn;
  nextRunAt: Date | null;
  pauseReason: "schedule_invalid" | null;
}>;

const CODE = /^[a-z][a-z0-9_]{0,63}$/u;

function latestInstantIn(schedule: ScheduledTaskSchedule, timeZone: string, after: Date, until: Date): Date | null {
  let latest: Date | null = null;
  // The window is the lateness bound: at most 13 hourly instants, one for the other kinds.
  for (let next = nextOccurrenceAfter(schedule, timeZone, after), steps = 0;
    next && next.getTime() <= until.getTime() && steps < 64;
    next = nextOccurrenceAfter(schedule, timeZone, next), steps += 1) latest = next;
  return latest;
}

/**
 * The occurrences a due task records at `now` and its next state. Only the
 * newest due instant within the lateness window runs; when older instants
 * were due too, the oldest one is recorded as missed for the whole backlog
 * (quietly), and when no instant lies within the window only that missed
 * record remains. The next instant is taken strictly after `now`; a once task
 * completes. A schedule that can no longer be computed (an unknown zone)
 * pauses the task after recording the due instant.
 */
export function planScheduledTaskClaim(
  task: Readonly<{ schedule: ScheduledTaskSchedule; timeZone: string; nextRunAt: Date }>,
  now: Date
): ScheduledTaskClaimPlan {
  const windowStart = new Date(now.getTime() - SCHEDULED_TASK_LATENESS_MS);
  const due = task.nextRunAt;
  const dueMissed = due.getTime() < windowStart.getTime();
  const once = task.schedule.kind === "once";
  try {
    const newest = once ? null
      : latestInstantIn(task.schedule, task.timeZone, new Date(Math.max(due.getTime(), windowStart.getTime()) - 1), now);
    const runAt = newest && newest.getTime() > due.getTime() ? newest : dueMissed ? null : due;
    const occurrences = runAt === null ? [{ missed: true, scheduledFor: due }]
      : runAt === due ? [{ missed: false, scheduledFor: due }]
        : [{ missed: true, scheduledFor: due }, { missed: false, scheduledFor: runAt }];
    if (once) return { nextRunAt: null, occurrences, pauseReason: null, status: "COMPLETED" };
    const nextRunAt = nextOccurrenceAfter(task.schedule, task.timeZone, now);
    return nextRunAt
      ? { nextRunAt, occurrences, pauseReason: null, status: "ACTIVE" }
      : { nextRunAt: null, occurrences, pauseReason: "schedule_invalid", status: "PAUSED" };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {
      nextRunAt: null, occurrences: [{ missed: dueMissed, scheduledFor: due }],
      pauseReason: once ? null : "schedule_invalid", status: once ? "COMPLETED" : "PAUSED"
    };
  }
}

/**
 * Task bookkeeping for a settled occurrence. Success resets the failure count;
 * a failed scheduled run counts and pauses an active task at the threshold or
 * on a permanent refusal decided under the current revision (a concurrent
 * owner edit wins). Manual runs never count failures or pause; skips change
 * nothing.
 */
export function planTaskSettlement(input: Readonly<{
  trigger: ScheduledTaskRunTrigger;
  outcome: ScheduledTaskOutcome;
  task: Readonly<{ status: ScheduledTaskStatusColumn; consecutiveFailures: number; revision: number }>;
  observedRevision?: number;
}>): Readonly<{ consecutiveFailures: number; pauseReason: ScheduledTaskPauseReason | null }> {
  const { outcome, task } = input;
  if (outcome.state === "COMPLETED") return { consecutiveFailures: 0, pauseReason: null };
  if (outcome.state === "SKIPPED" || input.trigger === "manual") {
    return { consecutiveFailures: task.consecutiveFailures, pauseReason: null };
  }
  const consecutiveFailures = task.consecutiveFailures + 1;
  if (task.status !== "ACTIVE") return { consecutiveFailures, pauseReason: null };
  if (outcome.pauseReason && (input.observedRevision === undefined || input.observedRevision === task.revision)) {
    return { consecutiveFailures, pauseReason: outcome.pauseReason };
  }
  return {
    consecutiveFailures,
    pauseReason: consecutiveFailures >= SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD ? "repeated_failures" : null
  };
}

/**
 * Whether a settlement is news for the owner: an unread result and a result
 * email (later a push). Only a shown result (every completed run until
 * monitoring outcomes exist) and a failure that paused the task are; routine
 * skips (missed, previous_running, superseded, chat_busy, paused) and other
 * failures stay in the run history only.
 */
export function settlementNotifiesOwner(outcome: Readonly<{ state: ScheduledTaskSettledState; taskPaused: boolean }>): boolean {
  return outcome.state === "COMPLETED" || (outcome.state === "FAILED" && outcome.taskPaused);
}

/** What the next same-chat run sees besides the prompt. */
export type ScheduledTaskBaseline = Readonly<{
  assistantMessageId: string;
  generation: number;
  runId: string;
  userMessageId: string;
}>;

/**
 * The baseline a settlement leaves: a completed (shown) result accepted under
 * the task's current generation; anything else, including a result of an
 * older generation, keeps the stored one.
 */
export function settlementBaseline(input: Readonly<{
  assistantMessageId: string | null;
  occurrence: Readonly<{ runId: string | null; taskGeneration: number | null; userMessageId: string | null }>;
  outcome: Readonly<{ state: ScheduledTaskSettledState }>;
  taskGeneration: number;
}>): ScheduledTaskBaseline | null {
  const { occurrence } = input;
  return input.outcome.state === "COMPLETED" && occurrence.taskGeneration === input.taskGeneration &&
    occurrence.runId !== null && occurrence.userMessageId !== null && input.assistantMessageId !== null
    ? { assistantMessageId: input.assistantMessageId, generation: input.taskGeneration, runId: occurrence.runId,
      userMessageId: occurrence.userMessageId }
    : null;
}

/** An open (pending or running) occurrence of a task whose next instant is being claimed. */
export type ScheduledTaskOpenOccurrence = Readonly<{
  id: string;
  leaseExpiresAt: Date | null;
  reasonCode: string | null;
  runId: string | null;
  state: string;
}>;

/**
 * How a newly due instant meets its task's open occurrences. A pending one
 * that holds no run and no live admission lease is fresh no longer: it ends
 * skipped (`chat_busy` after busy retries, else `superseded`) and the new
 * instant takes its place. Any other open occurrence of a recurring task is a
 * run still in progress, and the new instant is skipped `previous_running`
 * instead of queuing. A once task's only instant always queues.
 */
export function planClaimOverlap(input: Readonly<{
  now: Date;
  open: readonly ScheduledTaskOpenOccurrence[];
  recurring: boolean;
}>): Readonly<{ previousRunning: boolean; superseded: readonly Readonly<{ id: string; reasonCode: "chat_busy" | "superseded" }>[] }> {
  const waiting = (occurrence: ScheduledTaskOpenOccurrence) => occurrence.state === "PENDING" && occurrence.runId === null &&
    (occurrence.leaseExpiresAt === null || occurrence.leaseExpiresAt.getTime() <= input.now.getTime());
  return {
    previousRunning: input.recurring && input.open.some((occurrence) => !waiting(occurrence)),
    superseded: input.open.filter(waiting).map((occurrence) => ({
      id: occurrence.id, reasonCode: occurrence.reasonCode === "chat_busy" ? "chat_busy" as const : "superseded" as const
    }))
  };
}

/** A pending occurrence that may no longer be admitted, or null. */
export function expiredPendingOutcome(
  occurrence: Readonly<{ scheduledFor: Date; startedAt: Date | null; reasonCode: string | null }>,
  now: Date
): ScheduledTaskOutcome | null {
  if (now.getTime() - occurrence.scheduledFor.getTime() > SCHEDULED_TASK_LATENESS_MS) {
    return { reasonCode: "missed", state: "SKIPPED" };
  }
  if (occurrence.startedAt && now.getTime() - occurrence.startedAt.getTime() > SCHEDULED_TASK_RETRY_WINDOW_MS) {
    return occurrence.reasonCode === "chat_busy"
      ? { reasonCode: "chat_busy", state: "SKIPPED" }
      : { reasonCode: "admission_failed", state: "FAILED" };
  }
  return null;
}

function stableCode(value: unknown): string | null {
  return typeof value === "string" && CODE.test(value) ? value : null;
}

/** The settlement of a linked occurrence from its run, or null while the run is active. */
export function linkedRunOutcome(run: Readonly<{ status: string; errorPayload: unknown }> | null): ScheduledTaskOutcome | null {
  if (!run) return { reasonCode: "run_unavailable", state: "FAILED" };
  if (run.status === "complete") return { reasonCode: null, state: "COMPLETED" };
  if (run.status !== "cancelled" && run.status !== "error") return null;
  const payload = run.errorPayload;
  const code = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? stableCode((payload as Record<string, unknown>).code)
    : null;
  return { reasonCode: code ?? (run.status === "cancelled" ? "model_run_cancelled" : "run_failed"), state: "FAILED" };
}

export type ScheduledTaskRefusal =
  | Readonly<{ kind: "retry"; reasonCode: "chat_busy" | null }>
  | Readonly<{ kind: "fail"; outcome: ScheduledTaskOutcome }>;

const BUSY_CODES = new Set(["active_run_in_progress", "active_leaf_changed"]);
const TRANSIENT_CODES = new Set([
  "chat_not_found", "memory_owner_unavailable", "personal_draft_conflict", "provider_admission_changed",
  "scheduled_task_occurrence_unavailable"
]);
const PAUSE_CODES = new Map<string, ScheduledTaskPauseReason>([
  ["model_not_available", "model_unavailable"],
  ["search_strategy_not_available", "search_unavailable"],
  ["user_not_available", "account_inactive"],
  ["provider_not_available", "provider_unavailable"],
  ["credential_active_version_missing", "provider_unavailable"],
  ["credential_assignment_ambiguous", "provider_unavailable"],
  ["credential_assignment_required", "provider_unavailable"],
  ["credential_default_missing", "provider_unavailable"],
  ["credential_disabled", "provider_unavailable"],
  ["credential_not_found", "provider_unavailable"],
  ["credential_revoked", "provider_unavailable"]
]);

/** A permanent refusal: the occurrence fails and a scheduled task pauses with this reason. */
export function pausingOutcome(reason: ScheduledTaskPauseReason): ScheduledTaskOutcome {
  return { pauseReason: reason, reasonCode: reason, state: "FAILED" };
}

/**
 * How a send refusal that created no run affects its occurrence: busy chats,
 * transient races and server errors retry within the window (no run exists,
 * so nothing failed yet), catalog, entitlement and account refusals fail and
 * pause, anything else fails with its stable code. The runner rechecks the
 * owner itself for an unauthenticated refusal.
 */
export function classifySendRefusal(status: number, errorCode: unknown): ScheduledTaskRefusal {
  const code = stableCode(errorCode);
  if (code && BUSY_CODES.has(code)) return { kind: "retry", reasonCode: "chat_busy" };
  if (code && TRANSIENT_CODES.has(code)) return { kind: "retry", reasonCode: null };
  const pause = code ? PAUSE_CODES.get(code) : undefined;
  if (pause) return { kind: "fail", outcome: pausingOutcome(pause) };
  if (status >= 500) return { kind: "retry", reasonCode: null };
  return { kind: "fail", outcome: { reasonCode: code ?? "admission_failed", state: "FAILED" } };
}
