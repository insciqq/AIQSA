import {
  WORKSPACE_EXECUTION_OPEN_STATES,
  isWorkspaceSyncCleanupId,
  type WorkspaceExecutionRegistry
} from "./executionRegistry";
import type { WorkspaceRuntime } from "./runtime";
import type { WorkspaceOperation } from "./operationFence";

export type WorkspaceQuiescence = Readonly<{
  /** Every targeted execution is provably gone (closed, or the VM was stopped). */
  proven: boolean;
  stoppedVm: boolean;
}>;

/**
 * Proves that no guest process of a run (or of a whole session) survives.
 * Every registered execution is terminated through the runtime; anything the
 * registry cannot vouch for (an unknown termination result or an
 * unregistered or unobserved command) forces a disk-preserving VM stop.
 * Shared by coordinator settlement and the maintenance backstop so both
 * apply exactly the same rule.
 */
export async function quiesceWorkspaceExecutions(input: Readonly<{
  unregisteredCommands: number;
  modelRunId?: string;
  operation?: WorkspaceOperation;
  registry: WorkspaceExecutionRegistry;
  runtime: WorkspaceRuntime;
  runtimeSandboxId: string;
  sessionId: string;
  signal?: AbortSignal;
}>): Promise<WorkspaceQuiescence> {
  const scope = {
    operation: input.operation,
    sessionId: input.sessionId,
    ...(input.modelRunId ? { modelRunId: input.modelRunId } : {})
  };
  let proven = input.unregisteredCommands === 0;
  // Drain completed pages, then prove the query is empty. Cap work in a
  // single settlement; an overflow or a failed transition forces a VM stop.
  for (let page = 0; proven && page < 4; page += 1) {
    const open = await input.registry.listOpen(scope).catch(() => null);
    if (!open) { proven = false; break; }
    if (open.length === 0) return { proven: true, stoppedVm: false };
    if (open.some((execution) => isWorkspaceSyncCleanupId(execution.runtimeExecSessionId))) {
      proven = false;
      break;
    }
    for (const execution of open) {
      await input.registry.transition({ operation: input.operation, from: ["ACTIVE"], id: execution.id, to: "TERMINATING" })
        .catch(() => false);
    }
    const results = await input.runtime.terminateExecutions({
      operation: input.operation,
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
        result.runtimeExecSessionId === execution.runtimeExecSessionId && result.outcome === "closed") === true;
      if (!closed || !(await input.registry.transition({
        operation: input.operation,
        from: [...WORKSPACE_EXECUTION_OPEN_STATES], id: execution.id, to: "CLOSED"
      }).catch(() => false))) proven = false;
    }
  }
  if (proven) {
    const remaining = await input.registry.listOpen(scope).catch(() => null);
    if (remaining?.length === 0) return { proven: true, stoppedVm: false };
  }
  try {
    await input.runtime.stopSession({
      operation: input.operation,
      runtimeSandboxId: input.runtimeSandboxId,
      sessionId: input.sessionId,
      signal: input.signal
    });
  } catch {
    return { proven: false, stoppedVm: false };
  }
  try {
    await input.registry.closeAll({
      operation: input.operation,
      errorCode: "workspace_execution_cleanup_failed", sessionId: input.sessionId, to: "LOST"
    });
    const remaining = await input.registry.listOpen({ sessionId: input.sessionId });
    return { proven: remaining.length === 0, stoppedVm: true };
  } catch {
    return { proven: false, stoppedVm: true };
  }
}
