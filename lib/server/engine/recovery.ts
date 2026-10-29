import type { PrismaClient } from "@prisma/client";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { NormalizedRunWorkspace } from "../providers/types";
import { activeModelRunStatuses } from "../runs/prismaRepositoryShared";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { NativeRunStore } from "./runStore";

/**
 * Recovery of the engine's runs: a run still active in the database that no
 * execution of this process owns was
 * cut off by a restart or a crash. Nothing is sent again: its transcript,
 * files and outputs stay, its open calls keep an unknown outcome, and the run
 * ends interrupted with an answer that offers Continue (an ordinary next
 * turn). A run whose answer was already published completes instead. A run
 * counts as cut off when it started before this process did, or when it
 * stopped changing for the stale window (a live run is always in the
 * process's registry, so a long tool call never qualifies). Background
 * sub-agent runs (`subagentTurnId`) answer no message: they have their own
 * pass (`lib/server/runs/subagentBackground/recovery.ts`), which runs first,
 * and never enter this batch, so they cannot starve the main agent's orphans.
 */
export const NATIVE_RUN_INTERRUPTED = RUN_INTERRUPTED_FAILURE;

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
  findOrphans(input: Readonly<{ bootedBefore: Date; chatId?: string; limit: number; liveRunIds: readonly string[];
    staleBefore: Date; userId?: string }>): Promise<readonly NativeOrphanRun[]>;
  liveRunIds(): readonly string[];
  now?: () => Date;
  repository: Pick<RunRepository, "failRun">;
  runs: Pick<NativeRunStore, "complete">;
  /** The background sub-agent runs' own pass, in the same scope; it ends them interrupted and flushes their callbacks. */
  subagents?: (input: Readonly<{ chatId?: string; userId?: string }>) => Promise<number>;
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
export async function reconcileNativeRuns(deps: NativeRecoveryDeps, input: Readonly<{ chatId?: string; userId?: string }> = {}):
  Promise<number> {
  // Sub-agents first: their interruptions are owed before the main runs end, so each chat's terminal flushes and the
  // sub-agents' own flush meet in one coalesced wake-up.
  let settled = await deps.subagents?.(input).catch((error: unknown) => {
    logEvent("run_recovery", { action: "retry", code: "subagent_run_recovery_failed", error, outcome: "failed", stage: "recovery",
      subsystem: "run_recovery" });
    return 0;
  }) ?? 0;
  const now = deps.now?.() ?? new Date();
  const orphans = await deps.findOrphans({ bootedBefore: deps.bootedAt, limit: RECOVERY_BATCH, liveRunIds: deps.liveRunIds(),
    staleBefore: new Date(now.getTime() - NATIVE_RUN_STALE_MS), ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.userId ? { userId: input.userId } : {}) });
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
      // Recovery's own terminal write has its record: Admin Health counts the runs recovery failed from it.
      const stage = run.answerCompletedAt ? "complete" : "fail";
      const done = await (run.answerCompletedAt
        ? deps.runs.complete(scope)
        : deps.repository.failRun(run.id, run.assistantMessageId, NATIVE_RUN_INTERRUPTED, { recoveryTerminal: true })
      ).catch((writeError: unknown) => {
        logEvent("job_persistence", { action: "wait", outcome: "unconfirmed", prisma_code: databaseFailureCode(writeError),
          run_id: run.id, stage, subsystem: "run_recovery" });
        throw writeError;
      });
      logEvent("job_persistence", { outcome: done ? "confirmed" : "not_applied", run_id: run.id, stage, subsystem: "run_recovery" });
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

/**
 * The engine's runs still active that no execution of this process owns. A
 * run whose document preparation or Workspace hand-off is still pending
 * belongs to that job, which starts, expires or fails it, after a restart
 * too (`lib/server/uploads/chatPdfCoordinator.ts`, `lib/server/runs/workspaceFollowupCoordinator.ts`).
 */
export function createNativeOrphanFinder(client: Pick<PrismaClient, "modelRun">): NativeRecoveryDeps["findOrphans"] {
  return (input) => client.modelRun.findMany({
    orderBy: { updatedAt: "asc" },
    select: { answerCompletedAt: true, assistantMessageId: true, chatId: true, id: true, normalizedRequest: true, userId: true },
    take: input.limit,
    where: {
      engine: "native",
      status: { in: activeModelRunStatuses },
      // Main-agent runs only: a background sub-agent run has no answer to settle.
      subagentTurnId: null,
      ...(input.liveRunIds.length > 0 ? { id: { notIn: [...input.liveRunIds] } } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      OR: [{ createdAt: { lt: input.bootedBefore } }, { updatedAt: { lt: input.staleBefore } }],
      NOT: [
        { chatPdfPreparation: { is: { state: { in: ["pending", "preparing", "answer_ready"] } } } },
        { workspaceFollowup: { is: { state: { in: ["waiting", "preparing"] } } } }
      ]
    }
  });
}
