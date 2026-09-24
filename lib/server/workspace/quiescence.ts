import {
  WORKSPACE_EXECUTION_OPEN_STATES,
  WORKSPACE_EXECUTION_STOP_PROOF,
  isWorkspaceSyncCleanupId,
  type WorkspaceExecutionRegistry
} from "./executionRegistry";
import type { WorkspaceRuntime } from "./runtime";
import type { WorkspaceOperation } from "./operationFence";
import { logEvent } from "../observability";
import { workspaceLifecycleFailure } from "./lifecycleObservability";

function observeQuiescenceFailure(error: unknown): void {
  logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "quiesce", ...workspaceLifecycleFailure(error), action: "wait" });
}

export type WorkspaceQuiescence = Readonly<{
  /** Every targeted execution is provably gone (closed, or the VM was stopped). */
  proven: boolean;
  stoppedVm: boolean;
  failureCode?: "workspace_execution_stop_failed" | "workspace_execution_settlement_failed";
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
  let fallbackCode = proven ? "workspace_execution_drain_limit" : "workspace_execution_unregistered";
  // Drain completed pages, then prove the query is empty. Cap work in a
  // single settlement; an overflow or a failed transition forces a VM stop.
  for (let page = 0; proven && page < 4; page += 1) {
    const open = await input.registry.listOpen(scope).catch((error: unknown) => { observeQuiescenceFailure(error); return null; });
    if (!open) { fallbackCode = "workspace_execution_registry_unavailable"; proven = false; break; }
    if (open.length === 0) return { proven: true, stoppedVm: false };
    if (open.some((execution) => isWorkspaceSyncCleanupId(execution.runtimeExecSessionId))) {
      fallbackCode = "workspace_execution_sync_obligation";
      proven = false;
      break;
    }
    for (const execution of open) {
      await input.registry.transition({ operation: input.operation, from: ["ACTIVE"], id: execution.id, to: "TERMINATING" })
        .catch((error: unknown) => { observeQuiescenceFailure(error); return false; });
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
    }).catch((error: unknown) => { observeQuiescenceFailure(error); return null; });
    for (const execution of open) {
      const closed = results?.some((result) =>
        result.runtimeExecSessionId === execution.runtimeExecSessionId && result.outcome === "closed") === true;
      if (!closed || !(await input.registry.transition({
        operation: input.operation,
        from: [...WORKSPACE_EXECUTION_OPEN_STATES], id: execution.id, to: "CLOSED"
      }).catch((error: unknown) => { observeQuiescenceFailure(error); return false; }))) {
        fallbackCode = closed ? "workspace_execution_registry_unavailable" : "workspace_execution_termination_unknown";
        proven = false;
      }
    }
  }
  if (proven) {
    const remaining = await input.registry.listOpen(scope).catch((error: unknown) => { observeQuiescenceFailure(error); return null; });
    if (remaining?.length === 0) return { proven: true, stoppedVm: false };
    if (remaining === null) fallbackCode = "workspace_execution_registry_unavailable";
  }
  logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "quiesce", outcome: "degraded", code: fallbackCode, action: "stop" });
  try {
    await input.runtime.stopSession({
      operation: input.operation,
      runtimeSandboxId: input.runtimeSandboxId,
      sessionId: input.sessionId,
      signal: input.signal
    });
  } catch (error) {
    observeQuiescenceFailure(error);
    logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "shutdown", outcome: "failed", code: "workspace_execution_stop_failed", action: "wait" });
    return { proven: false, stoppedVm: false, failureCode: "workspace_execution_stop_failed" };
  }
  logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "shutdown", outcome: "completed", code: WORKSPACE_EXECUTION_STOP_PROOF, action: "none" });
  try {
    await input.registry.closeAll({
      operation: input.operation,
      errorCode: WORKSPACE_EXECUTION_STOP_PROOF, sessionId: input.sessionId, to: "LOST"
    });
    const remaining = await input.registry.listOpen({ sessionId: input.sessionId });
    if (remaining.length !== 0) throw new Error("workspace_execution_settlement_failed");
    logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "settle", outcome: "completed", code: WORKSPACE_EXECUTION_STOP_PROOF, action: "complete" });
    return { proven: true, stoppedVm: true };
  } catch (error) {
    observeQuiescenceFailure(error);
    logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "settle", outcome: "failed", code: "workspace_execution_settlement_failed", action: "wait" });
    return { proven: false, stoppedVm: true, failureCode: "workspace_execution_settlement_failed" };
  }
}
