import { bindContext, logEvent, type EventFields } from "../observability";
import { observedFailure } from "../providers/providerObservability";

type ToolFields = EventFields["tool_execution"];
type ResultCode = "operation_failed" | "workspace_shell_syntax_requires_shell";
const resultCodes = new WeakMap<object, ResultCode>();

/** Retain only the code created at our result boundary, without changing wire data. */
export function retainWorkspaceResultCode<T extends object>(result: T, code: ResultCode): T {
  resultCodes.set(result, code);
  return result;
}

export function inheritWorkspaceResultCode<T extends object>(source: object, result: T): T {
  const code = resultCodes.get(source);
  if (code !== undefined) resultCodes.set(result, code);
  return result;
}

export function workspaceToolFailure(error: unknown): Pick<ToolFields, "code" | "reason"> {
  const failure = observedFailure(error);
  return { code: failure.code, reason: failure.code === "workspace_tool_timeout" ? "deadline"
    : failure.code === "workspace_tool_cancelled" ? "cancelled" : failure.reason };
}

export function beginWorkspaceToolStage(stage: ToolFields["stage"]) {
  const startedAt = performance.now();
  const emit = bindContext((fields: Omit<ToolFields, "tool_kind" | "stage">) => logEvent("tool_execution", {
    tool_kind: "workspace", stage, outcome: fields.outcome, code: fields.code,
    reason: fields.reason, httpStatus: fields.httpStatus, action: fields.action,
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
    finish({ outcome });
    logEvent("tool_execution", { tool_kind: "workspace", stage: "result", outcome, code: resultCodes.get(result) });
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
