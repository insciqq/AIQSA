import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ThreadToolActivityOrigin } from "../../contracts/chats";
import type { RunProviderWait } from "../../contracts/runs";
import type { ModelToolCall } from "../tools/types";

/**
 * Minimal factual tool status for the active SSE response; never persisted.
 * A sent call is announced as `requested` and, once it settled, again with
 * its outcome and duration under the same identity (`ordinal`, its position
 * in its round), so its step stops when it finished. Content-free: no
 * arguments, results or error text.
 */
export function liveToolCallStatus(
  call: ModelToolCall,
  activity: Readonly<{
    origin?: ThreadToolActivityOrigin;
    round?: number;
    serverName?: string;
    toolName?: string;
    skillId?: string;
    skillName?: string;
    skillPath?: string;
    /** A page read's "host/path"; carried only with the `web_fetch` origin. */
    fetchTarget?: string;
  }> = {},
  progress: Readonly<{
    ordinal?: number;
    settled?: Readonly<{ durationMs: number; status: "complete" | "error" }>;
  }> = {}
): ModelRunSseEvent {
  const { ordinal, settled } = progress;
  return {
    data: {
      artifactType: "tool_call",
      payload: {
        name: activity.toolName ?? call.name,
        ...(activity.origin ? { origin: activity.origin } : {}),
        ...(Number.isSafeInteger(activity.round) && Number(activity.round) > 0
          ? { round: activity.round }
          : {}),
        ...(activity.serverName ? { serverName: activity.serverName } : {}),
        ...(activity.origin === "skill" ? {
          ...(activity.skillId ? { skillId: activity.skillId } : {}),
          ...(activity.skillName ? { skillName: activity.skillName } : {}),
          ...(activity.skillPath ? { skillPath: activity.skillPath } : {})
        } : {}),
        ...(activity.origin === "web_fetch" && activity.fetchTarget ? { fetchTarget: activity.fetchTarget } : {}),
        ...(Number.isSafeInteger(ordinal) && Number(ordinal) >= 0 ? { ordinal } : {}),
        ...(settled
          ? { durationMs: Number.isFinite(settled.durationMs) ? Math.max(0, Math.round(settled.durationMs)) : 0,
            status: settled.status }
          : { status: "requested" })
      }
    },
    type: "artifact"
  };
}

/**
 * Minimal factual phase status for the active SSE response; never persisted.
 * The server names only the phase that is doing work and the client owns the
 * words: `files` while stored conversation images are read, `knowledge`
 * while Knowledge is searched, `model` when a model request is sent (after a
 * tool round it reads the results) or its provider starts answering again,
 * `tools` when a declared batch starts. `wait` is what a model request is
 * waiting on its provider for.
 */
export function liveRunPhaseStatus(input: Readonly<{
  count?: number;
  phase: "files" | "knowledge" | "model" | "tools";
  wait?: RunProviderWait;
}>): ModelRunSseEvent {
  const count = Math.max(0, Math.floor(input.count ?? 0));
  return {
    data: {
      artifactType: "summary",
      payload: input.phase === "model"
        ? { stage: "model", status: input.wait ?? "waiting" }
        : input.phase === "tools" ? { count, stage: "tools", status: "running" } : { stage: input.phase, status: "running" }
    },
    type: "artifact"
  };
}
