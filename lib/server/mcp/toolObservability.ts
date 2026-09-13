import { bindContext, logEvent, type EventFields } from "../observability";
import { observedFailure } from "../providers/providerObservability";

type ToolFields = EventFields["tool_execution"];

export function mcpToolFailure(error: unknown): Pick<ToolFields, "code" | "reason" | "httpStatus"> {
  const failure = observedFailure(error);
  return {
    code: failure.code, httpStatus: failure.httpStatus,
    reason: failure.code === "mcp_request_timeout" ? "deadline"
      : failure.code === "mcp_request_cancelled" ? "cancelled" : failure.reason
  };
}

export function beginMcpToolStage(stage: ToolFields["stage"]) {
  const startedAt = performance.now();
  const emit = bindContext((fields: Omit<ToolFields, "tool_kind" | "stage">) => logEvent("tool_execution", {
    tool_kind: "mcp", stage, outcome: fields.outcome, code: fields.code,
    reason: fields.reason, httpStatus: fields.httpStatus, duration_ms: Math.max(0, performance.now() - startedAt)
  }));
  emit({ outcome: "started" });
  let finished = false;
  return (fields: Omit<ToolFields, "tool_kind" | "stage">) => {
    if (finished) return;
    finished = true;
    emit(fields);
  };
}

export function observeMcpAbort() {
  const startedAt = performance.now();
  let observed = false;
  return bindContext((fields: Pick<EventFields["nested_abort"], "abort_source" | "stage" | "timeout_ms" | "deadline_kind">) => {
    if (observed) return;
    observed = true;
    logEvent("nested_abort", { layer: "mcp", stage: fields.stage, abort_source: fields.abort_source,
      timeout_ms: fields.timeout_ms, deadline_kind: fields.deadline_kind,
      duration_ms: fields.stage === "delivery" ? Math.max(0, performance.now() - startedAt) : undefined });
  });
}
