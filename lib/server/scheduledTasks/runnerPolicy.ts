import {
  SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD,
  SCHEDULED_TASK_RUN_DEADLINE_MINUTES,
  type ScheduledTaskCheckOutcome,
  type ScheduledTaskKind,
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
/** Scheduled monitoring checks in a row without a reported outcome that pause their task. */
export const SCHEDULED_TASK_MISSING_VERDICT_PAUSE_THRESHOLD = 3;
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
  | "account_inactive" | "model_cannot_report" | "model_unavailable" | "provider_unavailable" | "repeated_failures"
  | "schedule_invalid" | "search_unavailable" | "skill_unavailable" | "source_unavailable" | "tools_unavailable"
  | "verdict_missing" | "workspace_secret_limit" | "workspace_unavailable";

export type ScheduledTaskOutcome = Readonly<{
  state: ScheduledTaskSettledState;
  reasonCode: string | null;
  /** A permanent admission refusal that pauses a scheduled (not manual) task. */
  pauseReason?: ScheduledTaskPauseReason;
}>;

/** What a monitoring check's model reported through its built-in tool. */
export type MonitoringVerdict = "update" | "no_update" | "goal_reached";
export const MONITORING_VERDICTS = ["update", "no_update", "goal_reached"] as const satisfies readonly MonitoringVerdict[];

export function isMonitoringVerdict(value: unknown): value is MonitoringVerdict {
  return (MONITORING_VERDICTS as readonly unknown[]).includes(value);
}

/**
 * How a completed monitoring check settles. Its `outcome` is the occurrence's
 * `reasonCode`, the run's transcript marker and the history copy; whether it
 * is news and whether it becomes the next check's previous result follow from
 * it (`settlementNotifiesOwner`, `settlementBaseline`): only `no_update` is
 * hidden, `could_not_check` is news only as the source alert or a pause, and
 * neither is a comparison basis.
 */
export type MonitoringCheckSettlement = Readonly<{
  outcome: ScheduledTaskCheckOutcome;
  /** The guarded goal completion of the task applies. */
  completesTask: boolean;
  /**
   * The model never reported: counts towards the `verdict_missing` pause, and
   * a report resets that count. Null for a check that could not check, which
   * its sources judge instead: its report neither counts nor resets.
   */
  verdictMissing: boolean | null;
}>;

/**
 * The verdict-to-settlement mapping of a completed monitoring check of the
 * task's current generation, free of I/O. Health comes first: a check whose
 * relevant source was unavailable (`healthIncomplete`) never settles as a
 * healthy `no_update` or `goal_reached`; it is shown as `could_not_check`. A
 * missing (or invalid, hence unrecorded) verdict is shown as `unreported`: an
 * update is never hidden by mistake. The first check of a generation (no
 * previous shown result) is always shown, as the `baseline`, unless it already
 * reached the goal. A reached goal completes the task only while no owner
 * transition happened since admission (`ownerUnchanged`); otherwise it is shown
 * as an ordinary `update`.
 */
export function monitoringCheckSettlement(input: Readonly<{
  firstCheck: boolean;
  healthIncomplete: boolean;
  ownerUnchanged: boolean;
  verdict: MonitoringVerdict | null;
}>): MonitoringCheckSettlement {
  const settle = (outcome: ScheduledTaskCheckOutcome, completesTask = false): MonitoringCheckSettlement =>
    ({ completesTask, outcome, verdictMissing: input.verdict === null });
  if (input.healthIncomplete) return { completesTask: false, outcome: "could_not_check", verdictMissing: null };
  if (input.verdict === null) return settle("unreported");
  if (input.verdict === "goal_reached") return input.ownerUnchanged ? settle("goal_reached", true) : settle("update");
  if (input.firstCheck) return settle("baseline");
  return settle(input.verdict);
}

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

/** A settlement's task bookkeeping: the counters, an automatic pause and the health alert. */
export type ScheduledTaskBookkeeping = Readonly<{
  consecutiveFailures: number;
  consecutiveIncompleteRuns: number;
  consecutiveMissingVerdicts: number;
  pauseReason: ScheduledTaskPauseReason | null;
  /** This settlement starts a streak of incomplete runs: the one health alert of that streak. */
  sourceAlert: boolean;
}>;

/**
 * Task bookkeeping for a settled occurrence. Success resets the failure count;
 * a failed scheduled run counts and pauses an active task at the threshold or
 * on a permanent refusal decided under the current revision (a concurrent
 * owner edit wins). Manual runs never count or pause; skips change nothing.
 *
 * Source health is separate from results: a completed run whose admission
 * lacked a relevant source (`sourcesIncomplete`) still completes and resets
 * the failure count, but a scheduled one extends the incomplete streak, whose
 * first run is the health alert and whose third pauses an active task with
 * `source_unavailable`. A complete run ends the streak; failures and skips
 * leave it as it is, and a manual incomplete run neither extends nor alerts.
 *
 * A completed scheduled monitoring check without a reported outcome
 * (`verdictMissing`) counts likewise towards a `verdict_missing` pause, and
 * any reported outcome resets that count; a check that could not check
 * reports neither (see `MonitoringCheckSettlement`), and the source pause
 * comes first.
 */
export function planTaskSettlement(input: Readonly<{
  trigger: ScheduledTaskRunTrigger;
  outcome: ScheduledTaskOutcome;
  sourcesIncomplete?: boolean;
  task: Readonly<{
    status: ScheduledTaskStatusColumn; consecutiveFailures: number; consecutiveIncompleteRuns: number;
    consecutiveMissingVerdicts: number; revision: number;
  }>;
  observedRevision?: number;
  /** A completed monitoring check whose report counts: whether its model never reported an outcome. */
  verdictMissing?: boolean;
}>): ScheduledTaskBookkeeping {
  const { outcome, task } = input;
  const manual = input.trigger === "manual";
  const streak = task.consecutiveIncompleteRuns;
  const missing = task.consecutiveMissingVerdicts;
  if (outcome.state === "COMPLETED") {
    const incomplete = input.sourcesIncomplete === true;
    const consecutiveIncompleteRuns = !incomplete ? 0 : manual ? streak : streak + 1;
    const consecutiveMissingVerdicts = input.verdictMissing === undefined || manual ? missing
      : input.verdictMissing ? missing + 1 : 0;
    const pausing = !manual && task.status === "ACTIVE";
    return {
      consecutiveFailures: 0,
      consecutiveIncompleteRuns,
      consecutiveMissingVerdicts,
      pauseReason: !pausing ? null
        : incomplete && consecutiveIncompleteRuns >= SCHEDULED_TASK_INCOMPLETE_PAUSE_THRESHOLD ? "source_unavailable"
          : input.verdictMissing === true && consecutiveMissingVerdicts >= SCHEDULED_TASK_MISSING_VERDICT_PAUSE_THRESHOLD
            ? "verdict_missing" : null,
      sourceAlert: incomplete && !manual && consecutiveIncompleteRuns === 1
    };
  }
  const unchanged = { consecutiveIncompleteRuns: streak, consecutiveMissingVerdicts: missing, sourceAlert: false };
  if (outcome.state === "SKIPPED" || manual) {
    return { ...unchanged, consecutiveFailures: task.consecutiveFailures, pauseReason: null };
  }
  const consecutiveFailures = task.consecutiveFailures + 1;
  if (task.status !== "ACTIVE") return { ...unchanged, consecutiveFailures, pauseReason: null };
  if (outcome.pauseReason && (input.observedRevision === undefined || input.observedRevision === task.revision)) {
    return { ...unchanged, consecutiveFailures, pauseReason: outcome.pauseReason };
  }
  return {
    ...unchanged,
    consecutiveFailures,
    pauseReason: consecutiveFailures >= SCHEDULED_TASK_FAILURE_PAUSE_THRESHOLD ? "repeated_failures" : null
  };
}

/**
 * Whether a settlement is news for the owner: an unread result, a result
 * email and a browser push all follow this one predicate. A shown result is
 * news: every completed run except a monitoring check with no update, which
 * never is, and one that could not check, which is news only as below. So
 * are a settlement that paused the task (a failure, the incomplete run that
 * ends a streak, the check that ends a streak without a report) and the
 * health alert that starts a streak of incomplete runs; later incomplete runs
 * of the same streak alert no more. Routine skips (missed, previous_running,
 * superseded, chat_busy, paused) and other failures stay in the run history
 * only.
 */
export function settlementNotifiesOwner(outcome: Readonly<{
  reasonCode: string | null;
  sourceAlert?: boolean;
  state: ScheduledTaskSettledState;
  taskPaused: boolean;
}>): boolean {
  const completed = outcome.state === "COMPLETED";
  if (completed && outcome.reasonCode === "no_update") return false;
  return (completed && outcome.reasonCode !== "could_not_check") || outcome.taskPaused || outcome.sourceAlert === true;
}

/** What the next same-chat run sees besides the prompt. */
export type ScheduledTaskBaseline = Readonly<{
  assistantMessageId: string;
  generation: number;
  runId: string;
  userMessageId: string;
}>;

/** Completed checks that never become the previous shown result: hidden ones and ones whose sources failed. */
const NOT_A_BASELINE: ReadonlySet<string> = new Set(["could_not_check", "no_update"] satisfies ScheduledTaskCheckOutcome[]);

/**
 * The baseline a settlement leaves: a completed shown result accepted under
 * the task's current generation; anything else, including a result of an
 * older generation, a monitoring check with no update and one whose sources
 * were unavailable, keeps the stored one.
 */
export function settlementBaseline(input: Readonly<{
  assistantMessageId: string | null;
  occurrence: Readonly<{ runId: string | null; taskGeneration: number | null; userMessageId: string | null }>;
  outcome: Readonly<{ reasonCode: string | null; state: ScheduledTaskSettledState }>;
  taskGeneration: number;
}>): ScheduledTaskBaseline | null {
  const { occurrence } = input;
  return input.outcome.state === "COMPLETED" && !NOT_A_BASELINE.has(input.outcome.reasonCode ?? "") &&
    occurrence.taskGeneration === input.taskGeneration &&
    occurrence.runId !== null && occurrence.userMessageId !== null && input.assistantMessageId !== null
    ? { assistantMessageId: input.assistantMessageId, generation: input.taskGeneration, runId: occurrence.runId,
      userMessageId: occurrence.userMessageId }
    : null;
}

/**
 * The monitoring settlement of a completed linked run, from its locked task
 * and occurrence; null for any other run. Only a run that a monitoring task
 * accepted under its current generation is a check (a changed prompt or type
 * bumps the generation, so the kind is still the admitted one); a result of an
 * older generation stays an ordinary shown result. No baseline of the current
 * generation means a first check; the revision the run was accepted under
 * proves that no owner transition happened since.
 */
export function completedRunCheck(input: Readonly<{
  /** A relevant source was unavailable during the check (source health of scheduled runs). */
  healthIncomplete: boolean;
  occurrence: Readonly<{ taskGeneration: number | null; taskRevision: number | null; verdict: string | null }>;
  task: Readonly<{ baselineGeneration: number | null; generation: number; kind: ScheduledTaskKind; revision: number }>;
}>): MonitoringCheckSettlement | null {
  const { occurrence, task } = input;
  if (task.kind !== "monitoring" || occurrence.taskGeneration !== task.generation) return null;
  return monitoringCheckSettlement({
    firstCheck: task.baselineGeneration !== task.generation,
    healthIncomplete: input.healthIncomplete,
    ownerUnchanged: occurrence.taskRevision === task.revision,
    verdict: isMonitoringVerdict(occurrence.verdict) ? occurrence.verdict : null
  });
}

/** Everything one settlement writes besides the occurrence's state and reason. */
export type ScheduledTaskSettlementPlan = ScheduledTaskBookkeeping & Readonly<{
  baseline: ScheduledTaskBaseline | null;
  /** A reached goal completes the task: a runner status transition. */
  goalCompletes: boolean;
  /** The result is news: an unread result, an email and a push. */
  notifies: boolean;
}>;

/**
 * The settlement rules of one occurrence, decided from its locked rows: the
 * task's counters, health alert and automatic pause, a monitoring goal's
 * completion (only when nothing paused the task), the notification matrix and
 * the baseline the next same-chat run sees. `sourcesIncomplete` is the source
 * health its admission froze; a monitoring `check` was settled from the same
 * record.
 */
export function planOccurrenceSettlement(input: Readonly<{
  assistantMessageId: string | null;
  check: MonitoringCheckSettlement | null;
  observedRevision?: number;
  occurrence: Readonly<{
    runId: string | null; taskGeneration: number | null; trigger: ScheduledTaskRunTrigger; userMessageId: string | null;
  }>;
  outcome: ScheduledTaskOutcome;
  sourcesIncomplete: boolean;
  task: Readonly<{
    consecutiveFailures: number; consecutiveIncompleteRuns: number; consecutiveMissingVerdicts: number; generation: number;
    revision: number; status: ScheduledTaskStatusColumn;
  }>;
}>): ScheduledTaskSettlementPlan {
  const { check, occurrence, outcome, task } = input;
  const plan = planTaskSettlement({
    observedRevision: input.observedRevision, outcome, sourcesIncomplete: input.sourcesIncomplete, task,
    trigger: occurrence.trigger, ...(check && check.verdictMissing !== null ? { verdictMissing: check.verdictMissing } : {})
  });
  const taskPaused = plan.pauseReason !== null;
  return {
    ...plan,
    baseline: settlementBaseline({ assistantMessageId: input.assistantMessageId, occurrence, outcome, taskGeneration: task.generation }),
    goalCompletes: check?.completesTask === true && !taskPaused,
    notifies: settlementNotifiesOwner({ reasonCode: outcome.reasonCode, sourceAlert: plan.sourceAlert, state: outcome.state, taskPaused })
  };
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

/** The chat is in use: retried, and once the window ends skipped as `chat_busy`. */
const BUSY_CODES = new Set(["active_run_in_progress", "active_leaf_changed"]);
/**
 * Races and outages that may clear within the window; still failing at its
 * end, the run fails once and counts toward the repeated-failure pause, so a
 * Workspace stuck busy never skips quietly forever.
 */
const TRANSIENT_CODES = new Set([
  "chat_not_found", "memory_owner_unavailable", "personal_draft_conflict", "provider_admission_changed",
  "scheduled_task_occurrence_unavailable",
  "mcp_not_ready", "workspace_busy", "workspace_followup_predecessor_failed", "workspace_followup_unavailable",
  "workspace_runtime_unavailable", "workspace_secret_unavailable"
]);
const PAUSE_CODES = new Map<string, ScheduledTaskPauseReason>([
  ["model_cannot_report", "model_cannot_report"],
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
  ["skill_not_available", "skill_unavailable"],
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
 * anything else fails with its stable code. A pinned Skill that admission
 * could not resolve pauses (`skill_unavailable`), while one whose version
 * changed between preparation and acceptance (the same code as a conflict)
 * retries and binds the new version. The runner rechecks the owner itself for
 * an unauthenticated refusal.
 */
export function classifySendRefusal(status: number, errorCode: unknown): ScheduledTaskRefusal {
  const code = stableCode(errorCode);
  if (code && BUSY_CODES.has(code)) return { kind: "retry", reasonCode: "chat_busy" };
  if (code && TRANSIENT_CODES.has(code)) return { kind: "retry", reasonCode: null };
  if (code === "skill_not_available" && status === 409) return { kind: "retry", reasonCode: null };

  const pause = code ? PAUSE_CODES.get(code) : undefined;
  if (pause) return { kind: "fail", outcome: pausingOutcome(pause) };
  if (status >= 500) return { kind: "retry", reasonCode: null };
  return { kind: "fail", outcome: { reasonCode: code ?? "admission_failed", state: "FAILED" } };
}
