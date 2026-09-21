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
