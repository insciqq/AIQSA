import type { PrismaClient } from "@prisma/client";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { logEvent } from "../observability";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { activeModelRunStatuses } from "./prismaRepositoryShared";
import { AGENT_MODE_REMOVED, isRetiredAgentRequest } from "./retiredAgent";
import type { RunRepository } from "./runRepositoryContract";

/**
 * Runs the old run core accepted (`ModelRun.engine = v1`) that were still
 * active when this release started: no process will ever finish them, since
 * the agent engine is the only engine left (operator decision 2026-10-23).
 * Each ends once, visibly: a Codex Agent turn as `agent_mode_removed`, every
 * other one interrupted with Continue (`RUN_INTERRUPTED_FAILURE`). Nothing is
 * sent again; partial text, files and usage stay, the Workspace keeps its
 * disk, its calls still running keep an unknown outcome that later native
 * turns respect (`TranscriptRepository.retiredRunEffects`), and a document
 * preparation or Workspace hand-off waiting for the run ends with it. The
 * startup sweep ends them all and keeps retrying a run whose settlement
 * failed; opening its chat or the user's next message ends it at once, so
 * one stuck run never holds a chat's next message. Logs carry counts only.
 */
export const RETIRED_AGENT_FAILURE = {
  code: AGENT_MODE_REMOVED,
  message: "Agent mode was removed, so this answer stopped. Nothing it started was replayed. Send the message again to continue."
} as const;

/** The failure codes this sweep writes on the old core's runs (`engine = v1`):
 * an upgrade ended them, nothing in AIQSA failed (admin attention leaves them out). */
export const RETIRED_ENGINE_FAILURE_CODES: readonly string[] = [RETIRED_AGENT_FAILURE.code, RUN_INTERRUPTED_FAILURE.code];

const RETIRED_RUN_BATCH = 100;

export type RetiredEngineRun = Readonly<{ assistantMessageId: string | null; id: string; normalizedRequest: unknown; userId: string }>;

/** Which old-core runs one pass ends: all of them, or one user's or one chat's. */
export type RetiredEngineRunScope = Readonly<{ chatId?: string; userId?: string }>;

export type RetiredEngineRunDeps = Readonly<{
  /** The old core's active runs in creation order, leaving out `skip`, within `scope`. */
  findRuns(input: RetiredEngineRunScope & Readonly<{ limit: number; skip: readonly string[] }>): Promise<readonly RetiredEngineRun[]>;
  repository: Pick<RunRepository, "failRun">;
  workspace?: Pick<WorkspaceCoordinator, "settle">;
}>;

export function createRetiredEngineRunFinder(client: Pick<PrismaClient, "modelRun">): RetiredEngineRunDeps["findRuns"] {
  return (input) => client.modelRun.findMany({
    orderBy: { createdAt: "asc" },
    select: { assistantMessageId: true, id: true, normalizedRequest: true, userId: true },
    take: input.limit,
    where: { engine: "v1", status: { in: activeModelRunStatuses }, ...(input.skip.length > 0 ? { id: { notIn: [...input.skip] } } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}), ...(input.userId ? { userId: input.userId } : {}) }
  });
}

/**
 * Ends one batch of the old core's active runs within `scope`, leaving out
 * `skip` (runs an earlier batch could not end); returns how many it found and
 * which of them it could not end. Ending is idempotent: a run another pass
 * ended meanwhile is no longer active and is skipped.
 */
export async function endRetiredEngineRuns(deps: RetiredEngineRunDeps,
  options: RetiredEngineRunScope & Readonly<{ skip?: ReadonlySet<string> }> = {}):
  Promise<Readonly<{ found: number; unended: readonly string[] }>> {
  const scoped = Boolean(options.chatId || options.userId);
  const runs = await deps.findRuns({ limit: RETIRED_RUN_BATCH, skip: [...options.skip ?? []],
    ...(options.chatId ? { chatId: options.chatId } : {}), ...(options.userId ? { userId: options.userId } : {}) });
  const unended: string[] = [];
  let agentTurns = 0;
  for (const run of runs) {
    const agent = isRetiredAgentRequest(run.normalizedRequest);
    try {
      // Guest authority is retired first; the disk and its files stay.
      await deps.workspace?.settle({ outcome: "failed", runId: run.id, userId: run.userId }).catch(() => undefined);
      // A run that never got its answer message has no message to mark; it still leaves the active set.
      const ended = await deps.repository.failRun(run.id, run.assistantMessageId ?? "",
        agent ? RETIRED_AGENT_FAILURE : RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });
      if (!ended) unended.push(run.id);
      else if (agent) agentTurns += 1;
    } catch (error) {
      unended.push(run.id);
      logEvent("run_recovery", { action: "retry", code: "retired_engine_run_failed", error, outcome: "failed", run_id: run.id,
        stage: "recovery", subsystem: "run_recovery" });
    }
  }
  if (runs.length > unended.length) {
    const stage = scoped ? "recovery" : "startup";
    logEvent("run_recovery", { code: "retired_engine_runs_ended", count: runs.length - unended.length, outcome: "completed",
      stage, subsystem: "run_recovery" });
    if (agentTurns > 0) {
      logEvent("run_recovery", { code: AGENT_MODE_REMOVED, count: agentTurns, outcome: "completed", stage, subsystem: "run_recovery" });
    }
  }
  return { found: runs.length, unended };
}

/**
 * Before a chat opens or a user's message is admitted: that chat's or user's
 * old-core runs end now, so a run the startup sweep could not end yet never
 * holds the chat's next message. A failure is logged and left to the sweep;
 * it never fails the read or the admission.
 */
export async function endRetiredEngineRunsFor(deps: RetiredEngineRunDeps, scope: RetiredEngineRunScope): Promise<void> {
  try {
    await endRetiredEngineRuns(deps, scope);
  } catch (error) {
    logEvent("run_recovery", { action: "retry", code: "retired_engine_runs_unavailable", error, outcome: "failed", stage: "recovery",
      subsystem: "run_recovery" });
  }
}

/** First and longest wait before the sweep tries runs it could not end again. */
export const RETIRED_RUN_RETRY_MS = Object.freeze({ first: 10_000, max: 5 * 60_000 });

/**
 * Ends every remaining run of the old core, a batch at a time, and stops
 * asking only once a pass found none left. A run that could not be ended (a
 * failed write) is left out for the rest of the pass, and the sweep tries
 * again after a wait that doubles up to `RETIRED_RUN_RETRY_MS.max`; a failed
 * read leaves the sweep for the next pass. A pass runs on every recovery tick
 * the wait allows.
 */
export function createRetiredEngineRunSweep(deps: RetiredEngineRunDeps): () => Promise<void> {
  let settled = false;
  let failedPasses = 0;
  let retryAt = 0;
  return async () => {
    if (settled || Date.now() < retryAt) return;
    const skip = new Set<string>();
    for (;;) {
      const batch = await endRetiredEngineRuns(deps, { skip });
      batch.unended.forEach((runId) => skip.add(runId));
      if (batch.found === 0) break;
    }
    if (skip.size === 0) {
      settled = true;
      return;
    }
    failedPasses += 1;
    const delay = Math.min(RETIRED_RUN_RETRY_MS.first * 2 ** (failedPasses - 1), RETIRED_RUN_RETRY_MS.max);
    retryAt = Date.now() + delay;
    logEvent("run_recovery", { action: "retry", attempt: failedPasses, code: "retired_engine_runs_unsettled", count: skip.size,
      delay_ms: delay, outcome: "waiting", stage: "recovery", subsystem: "run_recovery" });
  };
}
