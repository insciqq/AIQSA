import { interruptNativeRun } from "../engine/runInterruption";
import { logEvent } from "../observability";

/**
 * The Workspace coordinator's `onAttachedRunsInterrupted`: runs of a shared
 * session whose VM an unknown execution forced to stop. A background
 * sub-agent run of this process ends interrupted through its control, a
 * main-agent run through the engine's interruption; a run executing in no
 * process of this one is left to recovery, which ends it interrupted the
 * same way. Their next guest call is refused regardless.
 */
export async function interruptAttachedRuns(input: Readonly<{ chatId: string; runIds: readonly string[]; userId: string }>): Promise<void> {
  if (input.runIds.length === 0) return;
  // Imported on use: the coordinator's module must not load the background runs' composition with it.
  const { getDefaultSubagentBackground } = await import("./subagentBackground/default");
  const background = new Set(getDefaultSubagentBackground().control.interruptRuns(input));
  for (const runId of input.runIds) {
    if (background.has(runId)) continue;
    if (!interruptNativeRun(runId)) {
      logEvent("run_recovery", { action: "skip", code: "workspace_attached_run_not_local", outcome: "skipped", run_id: runId,
        stage: "recovery", subsystem: "run_recovery" });
    }
  }
}
