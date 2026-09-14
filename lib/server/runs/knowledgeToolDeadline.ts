import { KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS } from "../knowledge/toolExecutor";
import { bindContext, logEvent } from "../observability";

/** Observe the existing native deadline without changing its signal or policy. */
export async function withKnowledgeToolDeadline<T>(
  parents: readonly AbortSignal[],
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const deadline = AbortSignal.timeout(KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS);
  const signal = AbortSignal.any([...parents, deadline]);
  const startedAt = performance.now();
  logEvent("tool_deadline", {
    tool_kind: "knowledge", operation_stage: "retrieval",
    configured_timeout_ms: KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS,
    effective_timeout_ms: KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS
  });
  const observeAbort = bindContext(() => {
    const local = deadline.aborted && signal.reason === deadline.reason;
    logEvent("nested_abort", {
      layer: "knowledge", stage: "delivery", operation_stage: "retrieval",
      abort_source: local ? "knowledge_deadline" : "parent_signal",
      duration_ms: performance.now() - startedAt,
      ...(local ? { deadline_kind: "operation", timeout_ms: KNOWLEDGE_TOOL_EXECUTION_TIMEOUT_MS } as const : {})
    });
  });
  if (signal.aborted) logEvent("nested_abort", {
    layer: "knowledge", stage: "before_start", operation_stage: "retrieval", abort_source: "unknown"
  });
  else signal.addEventListener("abort", observeAbort, { once: true });
  try {
    return await operation(signal);
  } finally {
    signal.removeEventListener("abort", observeAbort);
  }
}
