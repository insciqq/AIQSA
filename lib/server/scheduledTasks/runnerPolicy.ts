import {
  SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD,
  SCHEDULED_TASK_RUN_DEADLINE_MINUTES,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskSchedule
} from "../../contracts/scheduledTasks";
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
/**
 * An admitted scheduled run is stopped through the Stop path this long after
 * its admission (the run's creation, not the occurrence's first attempt),
 * whether or not its task and history still exist.
 */
export const SCHEDULED_TASK_RUN_DEADLINE_MS = SCHEDULED_TASK_RUN_DEADLINE_MINUTES * 60 * 1000;
/** The terminal cause such a run keeps; its occurrence fails with it and counts as a failure. */
export const SCHEDULED_TASK_RUN_DEADLINE_CODE = "run_deadline";

export type ScheduledTaskStatusColumn = "ACTIVE" | "PAUSED" | "COMPLETED";
export type ScheduledTaskSettledState = "COMPLETED" | "FAILED" | "SKIPPED";
/** Stable codes of automatic pauses. */
export type ScheduledTaskPauseReason =
  | "account_inactive" | "model_unavailable" | "provider_unavailable" | "repeated_failures" | "schedule_invalid"
  | "search_unavailable" | "source_unavailable" | "tools_unavailable" | "workspace_secret_limit" | "workspace_unavailable";

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

export type ScheduledTaskSettlementPlan = Readonly<{
  consecutiveFailures: number;
  consecutiveIncompleteRuns: number;
  pauseReason: ScheduledTaskPauseReason | null;
  /** This settlement starts a streak of incomplete runs: the one health alert of that streak. */
  sourceAlert: boolean;
}>;

/**
 * Task bookkeeping for a settled occurrence. Success resets the failure count;
 * a failed scheduled run counts and pauses an active task at the threshold or
 * on a permanent refusal decided under the current revision (a concurrent
 * owner edit wins). Manual runs never count failures or pause; skips change
 * nothing.
 *
 * Source health is separate from results: a completed run whose admission
 * lacked a relevant source (`sourcesIncomplete`) still completes and resets
 * the failure count, but a scheduled one extends the incomplete streak, whose
 * first run is the health alert and whose third pauses an active task with
 * `source_unavailable`. A complete run ends the streak; failures and skips
 * leave it as it is, and a manual incomplete run neither extends nor alerts.
 */
export function planTaskSettlement(input: Readonly<{
  trigger: ScheduledTaskRunTrigger;
  outcome: ScheduledTaskOutcome;
  sourcesIncomplete?: boolean;
  task: Readonly<{
    status: ScheduledTaskStatusColumn; consecutiveFailures: number; consecutiveIncompleteRuns: number; revision: number;
  }>;
  observedRevision?: number;
}>): ScheduledTaskSettlementPlan {
  const { outcome, task } = input;
  const streak = task.consecutiveIncompleteRuns;
  if (outcome.state === "COMPLETED") {
    if (!input.sourcesIncomplete) return { consecutiveFailures: 0, consecutiveIncompleteRuns: 0, pauseReason: null, sourceAlert: false };
    if (input.trigger === "manual") return { consecutiveFailures: 0, consecutiveIncompleteRuns: streak, pauseReason: null, sourceAlert: false };
    const consecutiveIncompleteRuns = streak + 1;
    return {
      consecutiveFailures: 0,
      consecutiveIncompleteRuns,
      pauseReason: task.status === "ACTIVE" && consecutiveIncompleteRuns >= SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD
        ? "source_unavailable" : null,
      sourceAlert: consecutiveIncompleteRuns === 1
    };
  }
  if (outcome.state === "SKIPPED" || input.trigger === "manual") {
    return { consecutiveFailures: task.consecutiveFailures, consecutiveIncompleteRuns: streak, pauseReason: null, sourceAlert: false };
  }
  const consecutiveFailures = task.consecutiveFailures + 1;
  const failed = { consecutiveFailures, consecutiveIncompleteRuns: streak, sourceAlert: false };
  if (task.status !== "ACTIVE") return { ...failed, pauseReason: null };
  if (outcome.pauseReason && (input.observedRevision === undefined || input.observedRevision === task.revision)) {
    return { ...failed, pauseReason: outcome.pauseReason };
  }
  return {
    ...failed,
    pauseReason: consecutiveFailures >= SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD ? "repeated_failures" : null
  };
}

/**
 * Whether a settlement is news for the owner: an unread result and a result
 * email and push. Only a shown result (every completed run until monitoring
 * outcomes exist), a settlement that paused the task (a failure, or the
 * incomplete run that ends a streak) and the health alert that starts a
 * streak of incomplete runs are; later incomplete runs of the same streak
 * alert no more. Routine skips (missed, previous_running, superseded,
 * chat_busy, paused) and other failures stay in the run history only.
 */
export function settlementNotifiesOwner(outcome: Readonly<{
  sourceAlert?: boolean;
  state: ScheduledTaskSettledState;
  taskPaused: boolean;
}>): boolean {
  return outcome.state === "COMPLETED" || outcome.taskPaused || outcome.sourceAlert === true;
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

/** The chat or its Workspace is in use: retried, and once the window ends skipped as `chat_busy`. */
const BUSY_CODES = new Set(["active_run_in_progress", "active_leaf_changed", "workspace_busy"]);
/** Races and outages that may clear within the window; still failing at its end, the run fails once. */
const TRANSIENT_CODES = new Set([
  "chat_not_found", "memory_owner_unavailable", "personal_draft_conflict", "provider_admission_changed",
  "scheduled_task_occurrence_unavailable",
  "mcp_not_ready", "workspace_followup_predecessor_failed", "workspace_followup_unavailable",
  "workspace_runtime_unavailable", "workspace_secret_unavailable"
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
  ["credential_revoked", "provider_unavailable"],
  ["mcp_plan_too_large", "tools_unavailable"],
  ["mcp_tool_calling_not_supported", "tools_unavailable"],
  ["skills_count_exceeded", "tools_unavailable"],
  ["workspace_disabled", "workspace_unavailable"],
  ["workspace_model_tools_required", "workspace_unavailable"],
  ["workspace_runtime_incompatible", "workspace_unavailable"],
  ["workspace_secret_limit", "workspace_secret_limit"]
]);

/** A permanent refusal: the occurrence fails and a scheduled task pauses with this reason. */
export function pausingOutcome(reason: ScheduledTaskPauseReason): ScheduledTaskOutcome {
  return { pauseReason: reason, reasonCode: reason, state: "FAILED" };
}

/**
 * How a send refusal that created no run affects its occurrence: busy chats
 * and Workspaces, transient races, unavailable runtimes and storage, and
 * server errors retry within the window (no run exists, so nothing failed
 * yet); catalog, entitlement, account, tool and Workspace refusals that only
 * the owner or an administrator can lift fail and pause with human copy;
 * anything else fails with its stable code. The runner rechecks the owner
 * itself for an unauthenticated refusal.
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
