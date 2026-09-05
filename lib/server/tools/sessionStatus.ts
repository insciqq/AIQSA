import { sessionContextCapacity } from "../../contracts/sessionStatus";
import { measureSessionContext } from "../runs/runContextBudget";
import type { ProviderRunRequest } from "../providers/types";
import type { ModelToolCall, ProviderToolBridge, RunTool, ToolExecutionResult } from "./types";

export const SESSION_STATUS_TOOL_NAME = "get_session_status";
export const sessionStatusTool: RunTool = {
  capability: "session",
  description: "Read this chat's estimated context fullness and remaining space. Use when asked about context or continuing in a new chat. Read-only.",
  inputSchema: { additionalProperties: false, properties: {}, required: [], type: "object" },
  name: SESSION_STATUS_TOOL_NAME,
  strict: true
};

export function executeSessionStatus(
  call: ModelToolCall,
  request: ProviderRunRequest,
  bridge?: ProviderToolBridge
): ToolExecutionResult {
  if (Object.keys(call.arguments).length > 0) {
    return { callId: call.id, content: [{ type: "text", text: "get_session_status takes no arguments." }], name: call.name, status: "error" };
  }
  const status = measureSessionContext({ bridge, request });
  const capacity = sessionContextCapacity(status);
  return {
    callId: call.id,
    content: [{ type: "json", value: {
      approximate: true,
      contextPercent: capacity.percent,
      remainingTokens: capacity.availableTokens,
      contextTokens: status.approximateInputTokens,
      contextWindow: status.contextWindow,
      historyMessagesOmitted: status.droppedMessages,
      loadedTools: status.loadedTools,
      model: status.modelId,
      note: "Estimate for the current request, with room reserved for the answer. A new chat with a summary can help with long conversation history."
    } }],
    name: call.name,
    status: "complete"
  };
}
