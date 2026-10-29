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

const DEFERRED: ReadonlySet<SubagentCallbackDisposition> = new Set(["pending", "inactive_branch"]);

export type SubagentRecoveryDeps = Readonly<{
  bootedAt: Date;
  /** Delivers a chat's owed callbacks (`SubagentCallbacks.flush`). */
  flush(scope: SubagentChatScope): Promise<SubagentFlushReport>;
  /** Kept across passes by the composition. */
  deferred: SubagentDeferredCallbacks;
  liveRunIds(): readonly string[];
  now?: () => Date;
  staleMs: number;
  store: Pick<SubagentBackgroundStore, "findOrphans" | "findOwedCallbackChats" | "findTurn" | "interruptStrandedForegroundTurns" |
    "settle">;
  workspace?: Pick<WorkspaceAttachments, "detach">;
}>;

const chatKey = (scope: SubagentChatScope) => `${scope.userId}:${scope.chatId}`;

async function flushChat(deps: SubagentRecoveryDeps, scope: SubagentChatScope): Promise<void> {
  try {
    const report = await deps.flush(scope);
    const deferred = [...report.dispositions].flatMap(([turnId, disposition]) => DEFERRED.has(disposition) ? [turnId] : []);
    if (deferred.length > 0 && !report.chatGone) deps.deferred.set(chatKey(scope), new Set(deferred));
    else deps.deferred.delete(chatKey(scope));
  } catch (error) {
    // A failed flush is retried by the next pass.
    deps.deferred.delete(chatKey(scope));
    logEvent("run_recovery", { action: "retry", code: "subagent_callback_flush_failed", error, outcome: "failed",
      prisma_code: databaseFailureCode(error), stage: "recovery", subsystem: "run_recovery" });
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
    try {
      // Its guest authority is retired first: its processes are unknown, so they are proven stopped or the VM stops.
      await deps.workspace?.detach({ ...scope, execution: "unknown", modelRunId: orphan.runId }).catch(() => undefined);
      const turn = await deps.store.findTurn({ ...scope, turnId: orphan.turnId });
      const result = impliedResult({ modelId: turn?.model.id ?? "unknown", name: turn?.name ?? "subagent",
        reason: SUBAGENT_END_REASONS.restart, reasoningEffort: turn?.model.effort ?? null, state: "interrupted" });
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
  for (const scope of interrupted.values()) void flushChat(deps, scope);
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
    void flushChat(deps, scope);
  }
  return settled;
}
