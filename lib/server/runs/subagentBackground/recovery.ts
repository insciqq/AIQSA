import { SUBAGENT_END_REASONS } from "../../../contracts/subagents";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import type { SubagentChatScope, WorkspaceAttachments } from "../../subagents/ports";
import { impliedResult, type SubagentBackgroundStore } from "./store";

/**
 * Recovery of background sub-agent runs, beside the main agent's
 * (`lib/server/engine/recovery.ts`, whose orphan batch leaves them out so they
 * never starve it). A background run still active that no execution of this
 * process owns was cut off by a restart or a crash: nothing is replayed, its
 * transcript and files stay, and its turn ends `interrupted` (`restart`). Its
 * callback stays owed, and every chat it touched is flushed once after the
 * batch, so a restart wakes each chat's main agent at most once, with every
 * interruption listed (callbacks close together share one wake-up turn).
 */

const BACKGROUND_RECOVERY_BATCH = 50;

export type SubagentRecoveryDeps = Readonly<{
  bootedAt: Date;
  /** Delivers a chat's owed callbacks (`SubagentCallbacks.flush`). */
  flush(scope: SubagentChatScope): Promise<unknown>;
  liveRunIds(): readonly string[];
  now?: () => Date;
  staleMs: number;
  store: Pick<SubagentBackgroundStore, "findOrphans" | "findTurn" | "interruptStrandedForegroundTurns" | "settle">;
  workspace?: Pick<WorkspaceAttachments, "detach">;
}>;

export async function reconcileSubagentRuns(deps: SubagentRecoveryDeps,
  input: Readonly<{ chatId?: string; userId?: string }> = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const orphans = await deps.store.findOrphans({ bootedBefore: deps.bootedAt, limit: BACKGROUND_RECOVERY_BATCH,
    liveRunIds: deps.liveRunIds(), staleBefore: new Date(now.getTime() - deps.staleMs),
    ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.userId ? { userId: input.userId } : {}) });
  const chats = new Map<string, SubagentChatScope>();
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
      chats.set(`${scope.userId}:${scope.chatId}`, scope);
    } catch (error) {
      logEvent("run_recovery", { action: "retry", code: "subagent_run_recovery_failed", error, outcome: "failed",
        prisma_code: databaseFailureCode(error), run_id: orphan.runId, stage: "recovery", subsystem: "run_recovery" });
    }
  }
  await deps.store.interruptStrandedForegroundTurns(input).catch((error: unknown) => {
    logEvent("run_recovery", { action: "retry", code: "subagent_turn_recovery_failed", error, outcome: "failed",
      prisma_code: databaseFailureCode(error), stage: "recovery", subsystem: "run_recovery" });
  });
  // One flush per chat after the batch: the coalescing window joins it with any main run's terminal flush.
  for (const scope of chats.values()) {
    void deps.flush(scope).catch((error: unknown) => {
      logEvent("run_recovery", { action: "retry", code: "subagent_callback_flush_failed", error, outcome: "failed",
        stage: "recovery", subsystem: "run_recovery" });
    });
  }
  return settled;
}
