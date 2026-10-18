import { bindContext, logEvent, type EventFields, type WorkspaceFailureCause } from "../observability";
import { observedFailure } from "../providers/providerObservability";
import type { WorkspaceOperationFailureCode } from "@/lib/contracts/workspaceFailure";
import type { WorkspaceMcpToolName } from "@/lib/domain/workspace";

export type { WorkspaceFailureCause } from "../observability";

type ToolFields = EventFields["tool_execution"];
type ResultCode = "operation_failed" | "workspace_shell_syntax_requires_shell" | WorkspaceOperationFailureCode;
const resultCodes = new WeakMap<object, ResultCode>();

/** Every `WorkspaceFailureCause`; the logging leaf validates the same list. */
export const WORKSPACE_FAILURE_CAUSES = Object.freeze([
  "guest_operation_failed", "guest_exec_failed", "guest_path_denied", "guest_operation_refused", "guest_other", "guest_unparsed",
  "transport_timeout", "transport_closed", "transport_output_limit", "transport_invalid_request", "transport_other",
  "state_sandbox_unavailable", "state_mcp_unavailable"
] as const satisfies readonly WorkspaceFailureCause[]);
const causes = new Set<string>(WORKSPACE_FAILURE_CAUSES);
const failureCauses = new WeakMap<object, WorkspaceFailureCause>();

/** Retain only the code created at our result boundary, without changing wire data. */
export function retainWorkspaceResultCode<T extends object>(result: T, code: ResultCode): T {
  resultCodes.set(result, code);
  return result;
}

/** Carries a result's retained code and failure cause over to the result built from it. */
export function inheritWorkspaceResultCode<T extends object>(source: object, result: T): T {
  const code = resultCodes.get(source);
  if (code !== undefined) resultCodes.set(result, code);
  return inheritWorkspaceFailureCause(source, result);
}

export function isWorkspaceFailureCause(value: unknown): value is WorkspaceFailureCause {
  return typeof value === "string" && causes.has(value);
}

/**
 * Remembers why a failed result or error failed, for this process's records
 * only: neither the model nor the browser sees it, and nothing persists it.
 */
export function retainWorkspaceFailureCause<T extends object>(value: T, cause: WorkspaceFailureCause | undefined): T {
  if (cause !== undefined) failureCauses.set(value, cause);
  return value;
}

export function workspaceFailureCause(value: unknown): WorkspaceFailureCause | undefined {
  return typeof value === "object" && value !== null ? failureCauses.get(value) : undefined;
}

export function inheritWorkspaceFailureCause<T extends object>(source: object, result: T): T {
  return retainWorkspaceFailureCause(result, workspaceFailureCause(source));
}

/** The runner's JSON of a tool result: the result itself plus its cause, which the app takes off again. */
export function workspaceToolResultWire<T extends object>(result: T): T & Readonly<{ failureCause?: WorkspaceFailureCause }> {
  const cause = workspaceFailureCause(result);
  return cause === undefined ? result : { ...result, failureCause: cause };
}

/** The runner's error JSON of a failed call: its code plus its cause. */
export function workspaceToolErrorWire(code: string, error: unknown): Readonly<{ error: string; cause?: WorkspaceFailureCause }> {
  const cause = workspaceFailureCause(error);
  return cause === undefined ? { error: code } : { error: code, cause };
}

/** A runner's answered cause, validated; any other value is none. */
export function workspaceFailureCauseOfWire(value: unknown): WorkspaceFailureCause | undefined {
  return isWorkspaceFailureCause(value) ? value : undefined;
}

/**
 * Why a call failed: the shared failure reason, or, where that is only
 * `unknown`, the cause the runner observed.
 */
export function workspaceToolFailure(error: unknown): Pick<ToolFields, "code" | "reason"> {
  const failure = observedFailure(error);
  const reason = failure.code === "workspace_tool_timeout" ? "deadline"
    : failure.code === "workspace_tool_cancelled" ? "cancelled" : failure.reason;
  return { code: failure.code, reason: reason === "unknown" ? workspaceFailureCause(error) ?? reason : reason };
}

export function beginWorkspaceToolStage(stage: ToolFields["stage"], operation?: WorkspaceMcpToolName) {
  const startedAt = performance.now();
  const emit = bindContext((fields: Omit<ToolFields, "tool_kind" | "stage">) => logEvent("tool_execution", {
    tool_kind: "workspace", stage, outcome: fields.outcome, code: fields.code,
    reason: fields.reason, httpStatus: fields.httpStatus, action: fields.action, operation,
    duration_ms: Math.max(0, performance.now() - startedAt)
  }));
  emit({ outcome: "started" });
  let finished = false;
  return (fields: Omit<ToolFields, "tool_kind" | "stage">) => {
    if (finished) return;
    finished = true;
    emit(fields);
  };
}

export async function observeWorkspaceToolExecution<T extends { status: "complete" | "error" }>(
  operation: () => Promise<T>
): Promise<T> {
  const finish = beginWorkspaceToolStage("execution");
  try {
    const result = await operation();
    const outcome = result.status === "error" ? "failed" : "completed";
    const code = resultCodes.get(result);
    const reason = outcome === "failed" ? workspaceFailureCause(result) : undefined;
    // The result's code also tells the execution record why it failed, e.g. a
    // command's own non-zero exit, which is the model's result, not an error.
    finish({ outcome, code, reason });
    logEvent("tool_execution", { tool_kind: "workspace", stage: "result", outcome, code, reason });
    return result;
  } catch (error) {
    const failure = workspaceToolFailure(error);
    finish({ outcome: failure.reason === "cancelled" ? "cancelled" : "failed", ...failure });
    throw error;
  }
}

export function observeWorkspaceAbort() {
  const startedAt = performance.now();
  let observed = false;
  return bindContext((fields: Pick<EventFields["nested_abort"], "abort_source" | "stage" | "timeout_ms" | "deadline_kind">) => {
    if (observed) return;
    observed = true;
    logEvent("nested_abort", { layer: "workspace", stage: fields.stage, abort_source: fields.abort_source,
      timeout_ms: fields.timeout_ms, deadline_kind: fields.deadline_kind,
      duration_ms: fields.stage === "delivery" ? Math.max(0, performance.now() - startedAt) : undefined });
  });
}
