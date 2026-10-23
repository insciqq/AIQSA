import type { PrismaClient } from "@prisma/client";
import { logEvent } from "../observability";
import type { NormalizedRunWorkspace } from "../providers/types";
import { activeModelRunStatuses } from "../runs/prismaRepositoryShared";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { NativeRunStore } from "./runStore";

/**
 * Recovery of native runs only (the old core recovers its own): a native run
 * still active in the database that no execution of this process owns was
 * cut off by a restart or a crash. Nothing is sent again: its transcript,
 * files and outputs stay, its open calls keep an unknown outcome, and the run
 * ends interrupted with an answer that offers Continue (an ordinary next
 * turn). A run whose answer was already published completes instead. A run
 * counts as cut off when it started before this process did, or when it
 * stopped changing for the stale window (a live run is always in the
 * process's registry, so a long tool call never qualifies).
 */
export const NATIVE_RUN_INTERRUPTED = Object.freeze({
  code: "run_interrupted",
  message: "This answer was interrupted when the server restarted. Its work so far is kept; use Continue to pick it up."
});

/** Failure codes of an answer whose work is kept and that the next turn continues. */
export const CONTINUABLE_NATIVE_FAILURES: readonly string[] = [NATIVE_RUN_INTERRUPTED.code, "run_time_limit", "workspace_turn_time_limit"];

export const NATIVE_RUN_STALE_MS = 10 * 60_000;
const RECOVERY_BATCH = 50;

export type NativeOrphanRun = Readonly<{
  answerCompletedAt: Date | null;
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  normalizedRequest: unknown;
  userId: string;
}>;

export type NativeRecoveryDeps = Readonly<{
  /** When this process started; runs created before it have no execution here. */
  bootedAt: Date;
  findOrphans(input: Readonly<{ bootedBefore: Date; limit: number; liveRunIds: readonly string[]; staleBefore: Date;
    userId?: string }>): Promise<readonly NativeOrphanRun[]>;
  liveRunIds(): readonly string[];
  now?: () => Date;
  repository: Pick<RunRepository, "failRun">;
  runs: Pick<NativeRunStore, "complete">;
  workspace?: Pick<WorkspaceCoordinator, "settle">;
}>;

export function processBootedAt(): Date {
  return new Date(Date.now() - Math.round(process.uptime() * 1_000));
}

function runWorkspace(normalizedRequest: unknown): NormalizedRunWorkspace | undefined {
  if (typeof normalizedRequest !== "object" || normalizedRequest === null || Array.isArray(normalizedRequest)) return undefined;
  const workspace = (normalizedRequest as Record<string, unknown>).workspace;
  return typeof workspace === "object" && workspace !== null && (workspace as Record<string, unknown>).enabled === true
    ? workspace as NormalizedRunWorkspace : undefined;
}

/** Settles native runs no execution owns; returns how many it settled. */
export async function reconcileNativeRuns(deps: NativeRecoveryDeps, input: Readonly<{ userId?: string }> = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const orphans = await deps.findOrphans({ bootedBefore: deps.bootedAt, limit: RECOVERY_BATCH, liveRunIds: deps.liveRunIds(),
    staleBefore: new Date(now.getTime() - NATIVE_RUN_STALE_MS), ...(input.userId ? { userId: input.userId } : {}) });
  let settled = 0;
  for (const run of orphans) {
    // A run that started executing here after the query keeps its execution.
    if (deps.liveRunIds().includes(run.id) || !run.assistantMessageId) continue;
    const workspace = runWorkspace(run.normalizedRequest);
    try {
      // Guest authority is retired first; the disk and its files stay.
      if (workspace && deps.workspace) {
        await deps.workspace.settle({ outcome: "failed", runId: run.id, userId: run.userId, workspace }).catch(() => undefined);
      }
      const scope = { assistantMessageId: run.assistantMessageId, chatId: run.chatId, runId: run.id, userId: run.userId };
      const done = run.answerCompletedAt
        ? await deps.runs.complete(scope)
        : await deps.repository.failRun(run.id, run.assistantMessageId, NATIVE_RUN_INTERRUPTED, { recoveryTerminal: true });
      if (done) settled += 1;
      logEvent("run_recovery", { code: run.answerCompletedAt ? "native_run_completed" : NATIVE_RUN_INTERRUPTED.code,
        outcome: done ? "completed" : "skipped", run_id: run.id, stage: "recovery", subsystem: "run_recovery" });
    } catch (error) {
      logEvent("run_recovery", { action: "retry", code: "native_run_recovery_failed", error, outcome: "failed", run_id: run.id,
        stage: "recovery", subsystem: "run_recovery" });
    }
  }
  return settled;
}

/** The native runs still active that no execution of this process owns. */
export function createNativeOrphanFinder(client: Pick<PrismaClient, "modelRun">): NativeRecoveryDeps["findOrphans"] {
  return (input) => client.modelRun.findMany({
    orderBy: { updatedAt: "asc" },
    select: { answerCompletedAt: true, assistantMessageId: true, chatId: true, id: true, normalizedRequest: true, userId: true },
    take: input.limit,
    where: {
      engine: "native",
      status: { in: activeModelRunStatuses },
      ...(input.liveRunIds.length > 0 ? { id: { notIn: [...input.liveRunIds] } } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      OR: [{ createdAt: { lt: input.bootedBefore } }, { updatedAt: { lt: input.staleBefore } }]
    }
  });
}
