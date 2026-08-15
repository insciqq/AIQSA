import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ModelToolCall } from "../tools/types";

/** Minimal factual tool status for the active SSE response; never persisted. */
export function liveToolCallStatus(call: ModelToolCall): ModelRunSseEvent {
  return {
    data: {
      artifactType: "tool_call",
      payload: {
        name: call.name,
        status: "requested"
      }
    },
    type: "artifact"
  };
}

/** Minimal factual phase status for the active SSE response; never persisted. */
export function liveToolLoopStatus(input: Readonly<{
  count?: number;
  phase: "model" | "tools";
}>): ModelRunSseEvent {
  const count = Math.max(0, Math.floor(input.count ?? 0));
  return {
    data: {
      artifactType: "summary",
      payload: input.phase === "model"
        ? { stage: "model", status: "waiting" }
        : { count, stage: "tools", status: "running" }
    },
    type: "artifact"
  };
}
