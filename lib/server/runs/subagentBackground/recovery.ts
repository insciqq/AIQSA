import { SUBAGENT_END_REASONS } from "../../../contracts/subagents";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { SubagentCallbackDisposition, SubagentChatScope, WorkspaceAttachments } from "../../subagents/ports";
import type { SubagentFlushReport } from "./callbacks";
import { impliedResult, type SubagentBackgroundStore } from "./store";

/**
 * Recovery of background sub-agent runs, beside the main agent's
 * (`lib/server/engine/recovery.ts`, whose orphan batch leaves them out so they
 * never starve it). Two passes, both from durable rows:
 * - A background run still active that no execution of this process owns was
 *   cut off by a restart or a crash: nothing is replayed, its transcript and
 *   files stay, and its turn ends `interrupted` (`restart`).
 * - Callbacks still owed in a chat with no main-agent run active (their run
 *   ended before its flush fired, a flush failed, or a restart came between)
 *   are flushed, one coalesced flush per chat. Those a flush left owed on
 *   purpose, usage limits refusing the wake-up or a branch that is not the
 *   active one, wait for the next main-agent turn: recovery passes them by
 *   until another callback of the chat ends.
 * So a restart wakes each chat's main agent at most once, with every
 * interruption listed.
 */

const BACKGROUND_RECOVERY_BATCH = 50;
/** An ended turn younger than this is left to its own callback's flush (its coalescing window and admission). */
const OWED_GRACE_MS = 15_000;

/** Callbacks a flush left owed on purpose, per chat: recovery passes the chat by while nothing new is owed there. */
export type SubagentDeferredCallbacks = Map<string, ReadonlySet<string>>;
/** Chats whose wake-up failed for a reason that may clear: retried once `until` passes, the wait doubling per failure. */
export type SubagentFlushBackoff = Map<string, Readonly<{ failures: number; until: number }>>;

const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

const DEFERRED: ReadonlySet<SubagentCallbackDisposition> = new Set(["pending", "inactive_branch"]);

export type SubagentRecoveryDeps = Readonly<{
  bootedAt: Date;
  /** Delivers a chat's owed callbacks (`SubagentCallbacks.flush`). */
  flush(scope: SubagentChatScope): Promise<SubagentFlushReport>;
  /** Kept across passes by the composition. */
  backoff: SubagentFlushBackoff;
  /** Kept across passes by the composition. */
  deferred: SubagentDeferredCallbacks;
  liveRunIds(): readonly string[];
  now?: () => Date;
  staleMs: number;
  store: Pick<SubagentBackgroundStore, "findOrphans" | "findOwedCallbackChats" | "findTurn" | "interruptStrandedForegroundTurns" |
    "settle">;
  /**
   * Orphans whose Workspace authority a pass could not retire, by run: retried on later passes, and settled after
   * `SUBAGENT_RECOVERY_RETIRE_ATTEMPTS` failed ones. Kept across passes by the composition; absent, every pass retries.
   */
  retireFailures?: Map<string, number>;
  workspace?: Pick<WorkspaceAttachments, "attached" | "detach" | "fence">;
}>;

/**
 * Passes that may fail to retire an orphan's Workspace authority before it is settled anyway, behind a fenced session
 * (`WorkspaceAttachments.fence`) whose VM stop maintenance's backstop then proves: a turn never stays running for good.
 */
export const SUBAGENT_RECOVERY_RETIRE_ATTEMPTS = 10;

const chatKey = (scope: SubagentChatScope) => `${scope.userId}:${scope.chatId}`;

function backOff(deps: SubagentRecoveryDeps, key: string, at: number): void {
  const failures = (deps.backoff.get(key)?.failures ?? 0) + 1;
  deps.backoff.set(key, { failures, until: at + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1)) });
}

async function flushChat(deps: SubagentRecoveryDeps, scope: SubagentChatScope, at: number): Promise<void> {
  const key = chatKey(scope);
  try {
    const report = await deps.flush(scope);
    // Only usage limits and an inactive branch defer on purpose; a dispatch failure that may clear is retried later.
    const deferred = [...report.dispositions].flatMap(([turnId, disposition]) =>
      DEFERRED.has(disposition) && !report.retryable.has(turnId) ? [turnId] : []);
    if (deferred.length > 0 && !report.chatGone) deps.deferred.set(key, new Set(deferred));
    else deps.deferred.delete(key);
    if (report.retryable.size > 0) backOff(deps, key, at);
    else deps.backoff.delete(key);
  } catch (error) {
    // A failed flush is retried by a later pass, after its backoff.
    deps.deferred.delete(key);
    backOff(deps, key, at);
    logEvent("run_recovery", { action: "retry", code: "subagent_callback_flush_failed", error, outcome: "failed",
      prisma_code: databaseFailureCode(error), stage: "recovery", subsystem: "run_recovery" });
  }
}

/** Whether an orphan's Workspace authority is gone: its detach answered and the run is no longer attached. */
async function retired(deps: SubagentRecoveryDeps, scope: SubagentChatScope, runId: string): Promise<boolean> {
  const workspace = deps.workspace!;
  try {
    await workspace.detach({ ...scope, execution: "unknown", modelRunId: runId });
    return !(await workspace.attached(scope)).some((attachment) => attachment.modelRunId === runId);
  } catch {
    return false;
  }
}

export async function reconcileSubagentRuns(deps: SubagentRecoveryDeps,
  input: Readonly<{ chatId?: string; userId?: string }> = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const scoped = { ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.userId ? { userId: input.userId } : {}) };
  const orphans = await deps.store.findOrphans({ bootedBefore: deps.bootedAt, limit: BACKGROUND_RECOVERY_BATCH,
    liveRunIds: deps.liveRunIds(), staleBefore: new Date(now.getTime() - deps.staleMs), ...scoped });
  const interrupted = new Map<string, SubagentChatScope>();
  let settled = 0;
  for (const orphan of orphans) {
    // A run that started executing here after the query keeps its execution.
    if (deps.liveRunIds().includes(orphan.runId)) continue;
    const scope = { chatId: orphan.chatId, userId: orphan.userId };
    let unproven = false;
    try {
      // Its guest authority is retired first: its processes are unknown, so they are proven stopped or the VM stops.
      // Until that is confirmed (the run no longer attached) the turn stays as it is and the next pass tries again, so
      // no dead run keeps the chat's Workspace operation; past the bound it is settled behind a fenced Workspace.
      if (deps.workspace && !(await retired(deps, scope, orphan.runId))) {
        const failures = (deps.retireFailures?.get(orphan.runId) ?? 0) + 1;
        if (failures < SUBAGENT_RECOVERY_RETIRE_ATTEMPTS) {
          deps.retireFailures?.set(orphan.runId, failures);
          logEvent("run_recovery", { action: "retry", attempt: failures, code: "subagent_workspace_detach_failed", outcome: "failed",
            run_id: orphan.runId, stage: "recovery", subsystem: "run_recovery" });
          continue;
        }
        // Settled without proof, only once the chat's Workspace is fenced (a failed fence write retries next pass): no run
        // joins or claims a VM where this run's processes may still run, and the next send says it stopped working,
        // until maintenance's backstop proves the VM stopped or the user resets it.
        await deps.workspace.fence({ ...scope, modelRunId: orphan.runId });
        unproven = true;
        logEvent("run_recovery", { action: "degrade", attempt: failures, code: "subagent_workspace_stop_unproven", outcome: "degraded",
          run_id: orphan.runId, stage: "recovery", subsystem: "run_recovery" });
      }
      deps.retireFailures?.delete(orphan.runId);
      const turn = await deps.store.findTurn({ ...scope, turnId: orphan.turnId });
      const result = impliedResult({ modelId: turn?.model.id ?? "unknown", name: turn?.name ?? "subagent",
        reason: unproven ? SUBAGENT_END_REASONS.workspaceStopUnproven : SUBAGENT_END_REASONS.restart,
        reasoningEffort: turn?.model.effort ?? null, state: "interrupted" });
      const done = await deps.store.settle({ ...scope, result, turnId: orphan.turnId });
      logEvent("job_persistence", { outcome: done.settled ? "confirmed" : "not_applied", run_id: orphan.runId, stage: "fail",
        subsystem: "run_recovery" });
      if (done.settled) settled += 1;
      interrupted.set(chatKey(scope), scope);
    } catch (error) {
      logEvent("run_recovery", { action: "retry", code: "subagent_run_recovery_failed", error, outcome: "failed",
        prisma_code: databaseFailureCode(error), run_id: orphan.runId, stage: "recovery", subsystem: "run_recovery" });
    }
  }
  await deps.store.interruptStrandedForegroundTurns(input).catch((error: unknown) => {
    logEvent("run_recovery", { action: "retry", code: "subagent_turn_recovery_failed", error, outcome: "failed",
      prisma_code: databaseFailureCode(error), stage: "recovery", subsystem: "run_recovery" });
  });
  // Interrupted just now: flushed at once, one coalesced flush per chat.
  for (const scope of interrupted.values()) void flushChat(deps, scope, now.getTime());
  // Owed from before (an earlier flush that never ran or failed), whatever recovered above.
  const owed = await deps.store.findOwedCallbackChats({ endedBefore: new Date(now.getTime() - OWED_GRACE_MS),
    limit: BACKGROUND_RECOVERY_BATCH, ...scoped }).catch((error: unknown) => {
    logEvent("run_recovery", { action: "retry", code: "subagent_callback_flush_failed", error, outcome: "failed",
      prisma_code: databaseFailureCode(error), stage: "recovery", subsystem: "run_recovery" });
    return [];
  });
  for (const chat of owed) {
    const scope = { chatId: chat.chatId, userId: chat.userId };
    if (interrupted.has(chatKey(scope))) continue;
    const deferred = deps.deferred.get(chatKey(scope));
    if (deferred && chat.turnIds.every((turnId) => deferred.has(turnId))) continue;
    if ((deps.backoff.get(chatKey(scope))?.until ?? 0) > now.getTime()) continue;
    void flushChat(deps, scope, now.getTime());
  }
  return settled;
}
