import { mcpOversizedResponseMessage } from "../../contracts/mcpToolFailure";
import {
  McpClientSessionError,
  type McpFatalResponseErrorCode
} from "../mcp/clientSession";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";

export function mcpResponseOverflowCode(error: unknown): McpFatalResponseErrorCode | null {
  if (!(error instanceof McpClientSessionError)) return null;

  switch (error.code) {
    case "mcp_initialize_response_too_large":
    case "mcp_inventory_response_too_large":
    case "mcp_call_result_too_large":
    case "mcp_response_too_large":
      return error.code;
    default:
      return null;
  }
}

export function mcpResponseOverflowToolExecutionResult(
  call: ModelToolCall,
  error: unknown,
  label: "Search" | "Tool" | "Workspace" = "Tool"
): ToolExecutionResult | null {
  const code = mcpResponseOverflowCode(error);
  if (!code || !(error instanceof McpClientSessionError)) return null;

  const message = error.message;
  // The model learns how to ask for less; the durable preview keeps the code's message.
  const modelText = code === "mcp_call_result_too_large" ? mcpOversizedResponseMessage(error.maxBytes) : message;
  return {
    callId: call.id,
    content: [{ text: `${label} failed: ${modelText}`, type: "text" }],
    name: call.name,
    rawPreview: {
      finalProviderResponsePreview: { code, error: message },
      requestPreview: {
        toolCall: { id: call.id, name: call.name }
      }
    },
    status: "error",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    }
  };
}
