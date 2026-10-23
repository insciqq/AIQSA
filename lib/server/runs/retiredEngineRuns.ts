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
 * disk, and a document preparation or Workspace hand-off waiting for the run
 * ends with it. Logs carry counts only.
 */
export const RETIRED_AGENT_FAILURE = {
  code: AGENT_MODE_REMOVED,
  message: "Agent mode was removed, so this answer stopped. Nothing it started was replayed. Send the message again to continue."
} as const;

const RETIRED_RUN_BATCH = 100;

export type RetiredEngineRunDeps = Readonly<{
  client: Pick<PrismaClient, "modelRun">;
  repository: Pick<RunRepository, "failRun">;
  workspace?: Pick<WorkspaceCoordinator, "settle">;
}>;

/**
 * Ends one batch of the old core's active runs, leaving out `skip` (runs an
 * earlier batch could not end); returns how many it found and which of them
 * it could not end.
 */
export async function endRetiredEngineRuns(deps: RetiredEngineRunDeps, skip: ReadonlySet<string> = new Set()):
  Promise<Readonly<{ found: number; unended: readonly string[] }>> {
  const runs = await deps.client.modelRun.findMany({
    orderBy: { createdAt: "asc" },
    select: { assistantMessageId: true, id: true, normalizedRequest: true, userId: true },
    take: RETIRED_RUN_BATCH,
    where: { engine: "v1", status: { in: activeModelRunStatuses }, ...(skip.size > 0 ? { id: { notIn: [...skip] } } : {}) }
  });
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
  if (runs.length > 0) {
    logEvent("run_recovery", { code: "retired_engine_runs_ended", count: runs.length - unended.length, outcome: "completed",
      stage: "startup", subsystem: "run_recovery" });
    if (agentTurns > 0) {
      logEvent("run_recovery", { code: AGENT_MODE_REMOVED, count: agentTurns, outcome: "completed", stage: "startup",
        subsystem: "run_recovery" });
    }
  }
  return { found: runs.length, unended };
}

/** Passes a sweep makes before it leaves runs it could not end to the next process start. */
const RETIRED_RUN_PASSES = 3;

/**
 * Ends every remaining run of the old core, a batch at a time, and then stops
 * asking. A run that could not be ended (a failed write) is left out for the
 * rest of the pass and tried again on the next one, up to three passes; a
 * failed read leaves the whole sweep for the next pass.
 */
export function createRetiredEngineRunSweep(deps: RetiredEngineRunDeps): () => Promise<void> {
  let passes = 0;
  return async () => {
    if (passes >= RETIRED_RUN_PASSES) return;
    const skip = new Set<string>();
    for (;;) {
      const batch = await endRetiredEngineRuns(deps, skip);
      batch.unended.forEach((runId) => skip.add(runId));
      if (batch.found === 0) {
        passes = skip.size === 0 ? RETIRED_RUN_PASSES : passes + 1;
        return;
      }
    }
  };
}
