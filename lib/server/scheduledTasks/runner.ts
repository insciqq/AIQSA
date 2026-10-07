import { randomUUID } from "node:crypto";
import type { SmtpProductMessage } from "../email/definitions";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailureCode } from "../providers/providerObservability";
import type { ScheduledOccurrenceAdmission, ScheduledResultCopy } from "../runs/runRepositoryContract";
import { scheduledTaskSearchPlan, scheduledTaskSendBody, type ScheduledTaskSend, type ScheduledTaskSendTarget } from "./admission";
import { resolveScheduledTaskModel, type ScheduledTaskRunCatalogLoader } from "./catalog";
import { planScheduledTaskChat } from "./chatRotation";
import { SCHEDULED_TASK_HISTORY_SWEEP_INTERVAL_MS, type ScheduledTaskHistoryRetention } from "./historyRetention";
import { scheduledTaskResultEmail } from "./notifications";
import type { ScheduledTaskPinnedSkillLoader } from "./pinnedSkills";
import {
  SCHEDULED_TASK_ADMISSION_LEASE_MS,
  SCHEDULED_TASK_LATENESS_MS,
  SCHEDULED_TASK_MAX_EXECUTING,
  SCHEDULED_TASK_MAX_EXECUTING_PER_USER,
  SCHEDULED_TASK_RUN_DEADLINE_CODE,
  SCHEDULED_TASK_WORKSPACE_CARRYOVER_CODE,
  SCHEDULED_TASK_WORKSPACE_WAIT_CODE,
  SCHEDULED_WORKSPACE_MAX_CONCURRENT_DEFAULT,
  classifySendRefusal,
  pausingOutcome,
  scheduledDispatchNotBefore,
  scheduledTaskDispatchOffsetMs,
  settlementNotifiesOwner,
  type ScheduledTaskOutcome,
  type ScheduledTaskPauseReason
} from "./runnerPolicy";
import type { ScheduledTaskExecution, ScheduledTaskRunnerStore, ScheduledTaskSettlement } from "./runnerStore";
import type { ScheduledWorkspaceCarryover } from "./workspaceCarryover";

export type ScheduledTaskRunnerDeps = Readonly<{
  appBaseUrl: string;
  /** Detaches an execution from the tick; defaults to a plain promise. */
  background?: (work: () => Promise<void>) => Promise<void>;
  /** A task's dispatch offset for recurring schedules; defaults to its stable 0–180 s spread. */
  dispatchOffsetMs?: (taskId: string) => number;
  /**
   * Captures the `/workspace/project` of the chat a rotation leaves into a
   * seed for the new chat; without it a Workspace task's rotation waits.
   */
  carryWorkspace?: ScheduledWorkspaceCarryover;
  /** Wakes the next tick, e.g. after a run frees its owner's slot. */
  kick?: () => void;
  loadCatalog: ScheduledTaskRunCatalogLoader;
  /** The owner's current view of the task's pinned Skills, rechecked before every run. */
  loadPinnedSkills: ScheduledTaskPinnedSkillLoader;
  newId?: () => string;
  now?: () => Date;
  /** One bounded sweep of the tasks' history retention, run at most every quarter hour. */
  retainHistory?: ScheduledTaskHistoryRetention;
  send: ScheduledTaskSend;
  sendEmail?: (message: SmtpProductMessage) => Promise<unknown>;
  /** Queues the occurrence's browser push; the sender claims it at most once and never blocks the tick. */
  sendPush?: (occurrenceId: string) => void;
  /**
   * Stops an active run through the ordinary Stop path, keeping the given
   * terminal cause; the run deadline uses it.
   */
  stopRun: (input: Readonly<{ code: string; message: string; runId: string; userId: string }>) =>
    Promise<"stopped" | "not_cancelable" | "not_found">;
  store: ScheduledTaskRunnerStore;
  /**
   * Scheduled runs with Workspace on at once, installation-wide; occurrences
   * over it wait for a slot. Interactive runs keep the runner's remaining capacity.
   */
  workspaceMaxConcurrent?: number;
}>;

const BATCH = 50;
const RUN_DEADLINE_MESSAGE = "Scheduled run stopped at its time limit";
/** The pause a failed save-time admission maps to when the same check fails before a run. */
const RESOLUTION_PAUSES: Readonly<Record<
  "scheduled_task_model_cannot_report" | "scheduled_task_model_unavailable" | "scheduled_task_search_unavailable" |
  "scheduled_task_tools_unavailable" | "scheduled_task_workspace_unavailable",
  ScheduledTaskPauseReason
>> = {
  scheduled_task_model_cannot_report: "model_cannot_report",
  scheduled_task_model_unavailable: "model_unavailable",
  scheduled_task_search_unavailable: "search_unavailable",
  scheduled_task_tools_unavailable: "tools_unavailable",
  scheduled_task_workspace_unavailable: "workspace_unavailable"
};
/**
 * Result emails waiting for the one sending slot. Beyond this a burst drops
 * its emails (they are best effort) instead of growing without bound.
 */
const EMAIL_QUEUE_LIMIT = 200;

/** Content-free: occurrence and run identities, stable codes and counts only. */
function log(fields: Readonly<{
  action?: "fail" | "retry" | "skip";
  code?: string; count?: number; job_id?: string; outcome: "started" | "completed" | "failed" | "skipped" | "waiting";
  prisma_code?: string; run_id?: string;
  stage: "claim" | "cleanup" | "continuation" | "dispatch" | "fail" | "settle" | "retry" | "release";
}>): void {
  logEvent("job_attempt", { subsystem: "scheduled_tasks", ...fields });
}

function eventStream(response: Response): boolean {
  return response.headers.get("content-type")?.startsWith("text/event-stream") === true;
}

async function errorCode(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
  } catch {
    return undefined;
  }
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<void> {
  const reader = body?.getReader();
  if (!reader) return;
  try {
    while (!(await reader.read()).done) { /* The run executor persists everything; this stream stays private. */ }
  } finally {
    reader.releaseLock();
  }
}

type RunPlacement = Readonly<{
  chatPeriod: string | null;
  newChat?: Readonly<{ title: string }>;
  previousResult: ScheduledOccurrenceAdmission["previousResult"];
  previousResultCopy?: ScheduledResultCopy;
  /** The monthly rotation this run starts, from the task's current chat. */
  rotation?: Readonly<{ fromChatId: string }>;
  target: ScheduledTaskSendTarget;
}>;

/**
 * Where an occurrence posts (`planScheduledTaskChat`): in same-chat mode the
 * task's usable chat of the run's month, with the previous shown result of
 * the current generation as the only earlier turn the model sees (admission
 * keeps it only while it lies on that chat's path), or else the result its
 * rotation carried into that chat; at the first run of a later month a new
 * chat for that month that carries the previous shown result over; otherwise
 * a new chat, titled after the task (with the run's local date in new-chat
 * mode), whose context is the prompt alone. A new chat gets its title and
 * the task as its origin when its run is created.
 */
function runTarget(execution: ScheduledTaskExecution, newChatId: () => string): RunPlacement {
  const { carriedResult, chat, occurrence, task } = execution;
  const plan = planScheduledTaskChat({
    chat, chatMode: task.chatMode, chatPeriod: task.chatPeriod, scheduledFor: occurrence.scheduledFor, timeZone: task.timeZone,
    title: task.title
  });
  if (plan.kind === "continue") {
    const baseline = task.baseline?.generation === task.generation ? task.baseline : null;
    return {
      chatPeriod: plan.period,
      previousResult: baseline && { assistantMessageId: baseline.assistantMessageId, userMessageId: baseline.userMessageId },
      // Until the rotated chat has its own shown result, the copy carried into it stands in.
      ...(!baseline && carriedResult ? { previousResultCopy: carriedResult } : {}),
      target: { activeLeafMessageId: chat?.activeLeafMessageId ?? null, chatId: plan.chatId, kind: "existing" }
    };
  }
  return {
    chatPeriod: plan.period,
    newChat: { title: plan.title },
    previousResult: null,
    ...(plan.kind === "rotate" ? { rotation: { fromChatId: plan.fromChatId } } : {}),
    target: { chatId: newChatId(), kind: "new" }
  };
}

/**
 * The scheduled task runner. Each tick settles finished and expired
 * occurrences, records due ones and starts admissions within the caps
 * (installation-wide and per owner); admitted runs drain in this process, so
 * Stop in the chat reaches them. Nothing here holds a tick on a run.
 */
export function createScheduledTaskRunner(deps: ScheduledTaskRunnerDeps) {
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const background = deps.background ?? ((work) => work());
  const offsetMs = deps.dispatchOffsetMs ?? scheduledTaskDispatchOffsetMs;
  const workspaceCap = deps.workspaceMaxConcurrent ?? SCHEDULED_WORKSPACE_MAX_CONCURRENT_DEFAULT;
  const inFlight = new Map<string, Promise<void>>();
  /** Deadline stops in progress, by run, so a later tick does not stop a run twice. */
  const stopping = new Map<string, Promise<void>>();
  const emailQueue: string[] = [];
  let emailing: Promise<void> | null = null;
  /** The history sweep in progress, and when the last one started. */
  let sweeping: Promise<void> | null = null;
  let sweptAt: number | null = null;

  async function sendResultEmail(occurrenceId: string, sendEmail: NonNullable<ScheduledTaskRunnerDeps["sendEmail"]>): Promise<void> {
    try {
      // Best effort and at most once: the claim is recorded before sending.
      const notification = await deps.store.claimNotification(occurrenceId, clock());
      if (notification) await sendEmail(scheduledTaskResultEmail({ ...notification, appBaseUrl: deps.appBaseUrl }));
    } catch (error) {
      log({ action: "skip", code: "email_repository_failed", job_id: occurrenceId, outcome: "failed",
        prisma_code: databaseFailureCode(error), stage: "release" });
    }
  }

  /**
   * Sends queued result emails one at a time outside every tick and admission,
   * so slow SMTP never delays a run and a burst holds at most one slot of the
   * shared SMTP gate that sign-in and verification emails also use.
   */
  function pumpEmails(): void {
    const sendEmail = deps.sendEmail;
    const occurrenceId = emailing || !sendEmail ? undefined : emailQueue.shift();
    if (!sendEmail || occurrenceId === undefined) return;
    emailing = background(() => sendResultEmail(occurrenceId, sendEmail)).catch(() => undefined).finally(() => {
      emailing = null;
      pumpEmails();
    });
  }

  async function notify(settlements: readonly ScheduledTaskSettlement[]): Promise<void> {
    for (const settlement of settlements) {
      // An incomplete completed run logs its source health as its code.
      const code = settlement.reasonCode ?? (settlement.sourcesIncomplete ? "source_unavailable" : null);
      log({
        ...(code ? { code } : {}), job_id: settlement.occurrenceId,
        ...(settlement.runId ? { run_id: settlement.runId } : {}), stage: "settle",
        ...(settlement.state === "COMPLETED" ? { outcome: "completed" as const }
          : settlement.state === "SKIPPED" ? { outcome: "skipped" as const } : { action: "fail" as const, outcome: "failed" as const })
      });
      if (!settlementNotifiesOwner(settlement)) continue;
      try {
        deps.sendPush?.(settlement.occurrenceId);
      } catch {
        // Browser push is best effort and never holds a settlement.
      }
      if (!deps.sendEmail) continue;
      if (emailQueue.length >= EMAIL_QUEUE_LIMIT) {
        log({ action: "skip", code: "email_queue_full", job_id: settlement.occurrenceId, outcome: "skipped", stage: "release" });
        continue;
      }
      emailQueue.push(settlement.occurrenceId);
    }
    pumpEmails();
  }

  async function settlePending(execution: ScheduledTaskExecution, outcome: ScheduledTaskOutcome): Promise<"done"> {
    const settled = await deps.store.settlePending(execution.occurrence.id, outcome, clock(), execution.task.revision);
    if (settled) await notify([settled]);
    return "done";
  }

  /** Settles, runs or releases one leased occurrence; "retry" leaves it for a later tick. */
  async function admit(execution: ScheduledTaskExecution): Promise<"done" | "retry"> {
    const { occurrence, task } = execution;
    const now = clock();
    if (now.getTime() - occurrence.scheduledFor.getTime() > SCHEDULED_TASK_LATENESS_MS) {
      return settlePending(execution, { reasonCode: "missed", state: "SKIPPED" });
    }
    if (occurrence.trigger === "schedule" && task.status === "PAUSED") {
      return settlePending(execution, { reasonCode: "paused", state: "SKIPPED" });
    }
    if (!execution.ownerActive) return settlePending(execution, pausingOutcome("account_inactive"));
    // Current catalog and entitlement, the exact saved model and no substitute;
    // a monitoring check, tools and Workspace still need its tool calling.
    const catalog = await deps.loadCatalog(occurrence.userId);
    const resolution = resolveScheduledTaskModel(catalog, task);
    const model = catalog?.models.find((entry) => entry.modelId === task.modelId && entry.provider === task.provider);
    if (!resolution.ok || !catalog || !model) {
      return settlePending(execution, pausingOutcome(resolution.ok ? "model_unavailable" : RESOLUTION_PAUSES[resolution.code]));
    }
    const searchPlan = scheduledTaskSearchPlan({ catalog, model, searchEnabled: task.searchEnabled });
    if (!searchPlan) return settlePending(execution, pausingOutcome("search_unavailable"));
    // Every pinned Skill must still be the owner's to load (not deleted,
    // archived, disabled or unshared); the run never goes on in Auto without one.
    if (task.pinnedSkillIds.length > 0 &&
      (await deps.loadPinnedSkills(occurrence.userId, task.pinnedSkillIds)).some((skill) => !skill.available)) {
      return settlePending(execution, pausingOutcome("skill_unavailable"));
    }
    const placement = runTarget(execution, newId);
    const { previousResult, rotation, target } = placement;
    let previousResultCopy = placement.previousResultCopy;
    let seedId: string | null = null;
    if (rotation) {
      // The month's first run carries the previous shown result as a frozen
      // copy (never the old chat's ids) and, with Workspace on, the old chat's
      // project files, captured now: nothing runs in the new chat without them.
      const baseline = task.baseline?.generation === task.generation ? task.baseline : null;
      previousResultCopy = baseline ? await deps.store.loadRotationCopy({
        baseline, chatId: rotation.fromChatId, userId: occurrence.userId
      }) ?? undefined : undefined;
      if (task.workspaceEnabled) {
        const carried = deps.carryWorkspace
          ? await deps.carryWorkspace({ sourceChatId: rotation.fromChatId, taskId: occurrence.taskId, userId: occurrence.userId })
          : { kind: "retry" as const };
        if (carried.kind === "failed") {
          log({ action: "fail", code: SCHEDULED_TASK_WORKSPACE_CARRYOVER_CODE, job_id: occurrence.id, outcome: "failed",
            stage: "continuation" });
          return settlePending(execution, { reasonCode: SCHEDULED_TASK_WORKSPACE_CARRYOVER_CODE, state: "FAILED" });
        }
        if (carried.kind === "busy" || carried.kind === "retry") {
          const reasonCode = carried.kind === "busy" ? "chat_busy" as const : SCHEDULED_TASK_WORKSPACE_CARRYOVER_CODE;
          log({ code: reasonCode, job_id: occurrence.id, outcome: "waiting", stage: "retry" });
          await deps.store.retryLater(occurrence.id, reasonCode);
          return "retry";
        }
        seedId = carried.kind === "ready" ? carried.seedId : null;
      }
    }
    const response = await deps.send({
      body: scheduledTaskSendBody({
        admissionId: newId(), modelId: task.modelId, pinnedSkillIds: task.pinnedSkillIds, prompt: task.prompt,
        provider: task.provider, searchPlan, target,

        timeZone: task.timeZone, toolCalling: model.capabilities.toolCalling, toolsEnabled: task.toolsEnabled,
        workspaceEnabled: task.workspaceEnabled
      }),
      chatId: target.chatId,
      // The revision read above fences preparation against a pause or edit made
      // meanwhile, so the task kind it carries is the one the link accepts; the
      // chat epoch fences it against another run that moved the task's chat.
      occurrence: {
        chatPeriod: placement.chatPeriod, occurrenceId: occurrence.id, previousResult,
        relevantMcpServerIds: execution.relevantMcpServerIds, taskChatEpoch: task.chatEpoch,
        taskGeneration: task.generation, taskId: occurrence.taskId, taskRevision: task.revision,
        // Read with the revision above, so the link fence keeps the snapshot current.
        promptUrlDigests: task.promptUrlDigests,
        ...(placement.newChat ? { newChat: placement.newChat } : {}),
        ...(rotation ? { rotation: { fromChatId: rotation.fromChatId, seedId } } : {}),
        ...(previousResultCopy ? { previousResultCopy } : {}),
        ...(task.kind === "monitoring" ? { monitoring: true as const } : {}),
        ...(task.memoryEnabled ? { memory: true as const } : {})
      },
      userId: occurrence.userId
    });
    // The occurrence, not the HTTP outcome, says whether a run exists: admission links them atomically.
    const current = await deps.store.readOccurrence(occurrence.id);
    if (current?.state === "RUNNING" && current.runId) {
      log({ job_id: occurrence.id, outcome: "completed", run_id: current.runId, stage: "dispatch" });
      if (rotation) {
        // Best effort after the move: the old chat leaves the list unless the owner keeps it there.
        await deps.store.archiveRotatedChat({ chatId: rotation.fromChatId, taskId: occurrence.taskId, userId: occurrence.userId })
          .catch((error: unknown) => log({ action: "skip", code: "scheduled_task_chat_archive_skipped", job_id: occurrence.id,
            outcome: "failed", prisma_code: databaseFailureCode(error), stage: "dispatch" }));
      }
      await drain(response.body);
      const settled = await deps.store.settleLinked(occurrence.id, clock());
      if (settled) await notify([settled]);
      return "done";
    }
    let code: unknown;
    // An accepted run whose occurrence vanished with its task still finishes in its chat.
    if (eventStream(response)) await drain(response.body);
    else code = await errorCode(response);
    if (current?.state !== "PENDING") return "done";
    if (response.ok) {
      // Accepted without a visible link: never admit this occurrence again.
      return settlePending(execution, { reasonCode: "admission_failed", state: "FAILED" });
    }
    if (response.status === 401) {
      const owner = await deps.store.loadExecution(occurrence.id);
      return settlePending(execution, owner && !owner.ownerActive
        ? pausingOutcome("account_inactive")
        : { reasonCode: "admission_failed", state: "FAILED" });
    }
    const refusal = classifySendRefusal(response.status, code);
    if (refusal.kind === "wait") {
      log({ code: SCHEDULED_TASK_WORKSPACE_WAIT_CODE, job_id: occurrence.id, outcome: "waiting", stage: "retry" });
      await deps.store.waitForWorkspace(occurrence.id, clock());
      return "retry";
    }
    if (refusal.kind === "retry") {
      log({ ...(refusal.reasonCode ? { code: refusal.reasonCode } : {}), job_id: occurrence.id, outcome: "waiting", stage: "retry" });
      await deps.store.retryLater(occurrence.id, refusal.reasonCode);
      return "retry";
    }
    return settlePending(execution, refusal.outcome);
  }

  async function execute(occurrenceId: string): Promise<void> {
    let outcome: "done" | "retry" = "done";
    try {
      const execution = await deps.store.loadExecution(occurrenceId);
      if (execution) outcome = await admit(execution);
    } catch (error) {
      outcome = "retry";
      log({ action: "retry", code: observedFailureCode(error), job_id: occurrenceId, outcome: "failed",
        prisma_code: databaseFailureCode(error), stage: "dispatch" });
      // Only an unlinked pending occurrence is released; a linked one follows its run.
      await deps.store.retryLater(occurrenceId, null).catch(() => undefined);
    }
    // A finished occurrence frees its owner's slot at once; a retry waits for the next interval.
    if (outcome === "done") deps.kick?.();
  }

  /**
   * Stops every scheduled run past its deadline through the Stop path, in
   * the background: its executor ends the run and its occurrence settles as
   * failed `run_deadline`, by the run's own origin even when the task is gone.
   */
  async function stopOverdueRuns(now: Date): Promise<void> {
    for (const overdue of await deps.store.overdueRuns(now, BATCH)) {
      if (stopping.has(overdue.runId)) continue;
      log({ action: "fail", code: SCHEDULED_TASK_RUN_DEADLINE_CODE, outcome: "started", run_id: overdue.runId, stage: "fail" });
      const stop = background(async () => {
        try {
          await deps.stopRun({ code: SCHEDULED_TASK_RUN_DEADLINE_CODE, message: RUN_DEADLINE_MESSAGE, ...overdue });
        } catch (error) {
          log({ action: "retry", code: observedFailureCode(error), outcome: "failed", prisma_code: databaseFailureCode(error),
            run_id: overdue.runId, stage: "fail" });
        }
      }).catch(() => undefined).finally(() => stopping.delete(overdue.runId));
      stopping.set(overdue.runId, stop);
    }
  }

  /**
   * Starts one bounded sweep of the tasks' history retention outside the
   * tick, at most every quarter hour; a failed sweep waits for the next.
   */
  function sweepHistory(now: Date): void {
    const retain = deps.retainHistory;
    if (!retain || sweeping || (sweptAt !== null && now.getTime() - sweptAt < SCHEDULED_TASK_HISTORY_SWEEP_INTERVAL_MS)) return;
    sweptAt = now.getTime();
    sweeping = background(async () => {
      try {
        await retain(now);
      } catch (error) {
        log({ action: "retry", code: "scheduled_task_history_retention_failed", outcome: "failed",
          prisma_code: databaseFailureCode(error), stage: "cleanup" });
      }
    }).catch(() => undefined).finally(() => { sweeping = null; });
  }

  /**
   * Starts admissions oldest instant first within the caps: installation-wide,
   * per owner and, for tasks with Workspace on, the scheduled Workspace cap.
   * A recurring occurrence waits for its task's spread first; one over the
   * Workspace cap is shown waiting for a slot and keeps its place.
   */
  async function dispatch(now: Date): Promise<void> {
    const { executing, pending, workspaceExecuting } = await deps.store.loadDispatch(now, BATCH * 2);
    const perUser = new Map(executing);
    let total = [...perUser.values()].reduce((sum, count) => sum + count, 0);
    let workspace = workspaceExecuting;
    for (const candidate of pending) {
      if (total >= SCHEDULED_TASK_MAX_EXECUTING) break;
      if (inFlight.has(candidate.id) || (perUser.get(candidate.userId) ?? 0) >= SCHEDULED_TASK_MAX_EXECUTING_PER_USER) continue;
      if (scheduledDispatchNotBefore(candidate, offsetMs).getTime() > now.getTime()) continue;
      if (candidate.workspace && workspace >= workspaceCap) {
        if (!candidate.waiting) {
          log({ code: SCHEDULED_TASK_WORKSPACE_WAIT_CODE, job_id: candidate.id, outcome: "waiting", stage: "dispatch" });
          await deps.store.waitForWorkspace(candidate.id, now);
        }
        continue;
      }
      if (!await deps.store.acquireLease(candidate.id, now, new Date(now.getTime() + SCHEDULED_TASK_ADMISSION_LEASE_MS))) continue;
      total += 1;
      if (candidate.workspace) workspace += 1;
      perUser.set(candidate.userId, (perUser.get(candidate.userId) ?? 0) + 1);
      log({ job_id: candidate.id, outcome: "started", stage: "dispatch" });
      const execution = background(() => execute(candidate.id)).finally(() => inFlight.delete(candidate.id));
      inFlight.set(candidate.id, execution);
    }
  }

  return {
    async tick(): Promise<void> {
      const now = clock();
      // No unattended run outlives its deadline, whatever else this tick does.
      await stopOverdueRuns(now);
      // Settle first so finished runs free their slots before this tick dispatches.
      await notify(await deps.store.settleFinishedRuns(now, BATCH));
      await notify(await deps.store.expirePending(now, BATCH));
      const claim = await deps.store.claimDue(now, BATCH);
      if (claim.claimed > 0) log({ count: claim.claimed, outcome: "completed", stage: "claim" });
      await notify(claim.settlements);
      await dispatch(now);
      sweepHistory(now);
    },
    /**
     * Resolves when the executions, deadline stops and history sweep started
     * so far and the queued emails have settled (tests and shutdown).
     */
    async idle(): Promise<void> {
      while (inFlight.size > 0 || stopping.size > 0 || emailing || sweeping) {
        await Promise.allSettled([...inFlight.values(), ...stopping.values(), ...(emailing ? [emailing] : []),
          ...(sweeping ? [sweeping] : [])]);
      }
    }
  };
}

export type ScheduledTaskRunner = ReturnType<typeof createScheduledTaskRunner>;
