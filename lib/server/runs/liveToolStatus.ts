import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ThreadToolActivityOrigin } from "../../contracts/chats";
import type { ModelToolCall } from "../tools/types";

/** Minimal factual tool status for the active SSE response; never persisted. */
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
  }> = {}
): ModelRunSseEvent {
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
        status: "requested"
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
 * tool round it reads the results), `tools` when a declared batch starts.
 */
export function liveRunPhaseStatus(input: Readonly<{
  count?: number;
  phase: "files" | "knowledge" | "model" | "tools";
}>): ModelRunSseEvent {
  const count = Math.max(0, Math.floor(input.count ?? 0));
  return {
    data: {
      artifactType: "summary",
      payload: input.phase === "model"
        ? { stage: "model", status: "waiting" }
        : input.phase === "tools" ? { count, stage: "tools", status: "running" } : { stage: input.phase, status: "running" }
    },
    type: "artifact"
  };
}
