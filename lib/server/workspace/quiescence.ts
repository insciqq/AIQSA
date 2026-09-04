import {
  WORKSPACE_EXECUTION_OPEN_STATES,
  type WorkspaceExecutionRegistry
} from "./executionRegistry";
import type { WorkspaceRuntime } from "./runtime";

export type WorkspaceQuiescence = Readonly<{
  /** Every targeted execution is provably gone (closed, or the VM was stopped). */
  proven: boolean;
  stoppedVm: boolean;
}>;

/**
 * Proves that no guest process of a run (or of a whole session) survives.
 * Every registered execution is terminated through the runtime; anything the
 * registry cannot vouch for (an unknown termination result or a
 * crash-ambiguous `sandbox_exec_start`) forces a disk-preserving VM stop.
 * Shared by coordinator settlement and the maintenance backstop so both
 * apply exactly the same rule.
 */
export async function quiesceWorkspaceExecutions(input: Readonly<{
  ambiguousStarts: number;
  modelRunId?: string;
  registry: WorkspaceExecutionRegistry;
  runtime: WorkspaceRuntime;
  runtimeSandboxId: string;
  sessionId: string;
  signal?: AbortSignal;
}>): Promise<WorkspaceQuiescence> {
  const open = await input.registry.listOpen({
    sessionId: input.sessionId,
    ...(input.modelRunId ? { modelRunId: input.modelRunId } : {})
  });
  let proven = input.ambiguousStarts === 0;
  if (open.length > 0) {
    for (const execution of open) {
      await input.registry.transition({ from: ["ACTIVE"], id: execution.id, to: "TERMINATING" });
    }
    const results = await input.runtime.terminateExecutions({
      executions: open.map((execution) => ({
        modelRunId: execution.modelRunId,
        runtimeExecSessionId: execution.runtimeExecSessionId
      })),
      runtimeSandboxId: input.runtimeSandboxId,
      sessionId: input.sessionId,
      signal: input.signal
    }).catch(() => null);
    for (const execution of open) {
      const closed = results?.some((result) =>
        result.runtimeExecSessionId === execution.runtimeExecSessionId &&
        result.outcome === "closed") === true;
      if (closed) {
        await input.registry.transition({
          from: [...WORKSPACE_EXECUTION_OPEN_STATES],
          id: execution.id,
          to: "CLOSED"
        });
      } else {
        proven = false;
      }
    }
  }
  if (proven) return { proven: true, stoppedVm: false };
  try {
    await input.runtime.stopSession({
      runtimeSandboxId: input.runtimeSandboxId,
      sessionId: input.sessionId,
      signal: input.signal
    });
  } catch {
    return { proven: false, stoppedVm: false };
  }
  await input.registry.closeAll({
    errorCode: "workspace_execution_cleanup_failed",
    sessionId: input.sessionId,
    to: "LOST",
    ...(input.modelRunId ? { modelRunId: input.modelRunId } : {})
  }).catch(() => 0);
  return { proven: true, stoppedVm: true };
}
