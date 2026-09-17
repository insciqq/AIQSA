/** Closed public reasons; raw MCP results and exception messages stay private. */
const messages = {
  mcp_call_result_too_large: "MCP tool response exceeded its size limit.",
  mcp_call_result_invalid: "MCP tool returned an invalid response.",
  mcp_call_result_unsupported: "MCP tool returned unsupported content."
} as const;

export type McpToolFailure = keyof typeof messages;

export function decodeMcpToolFailure(value: unknown): McpToolFailure | null {
  return typeof value === "string" && Object.hasOwn(messages, value) ? value as McpToolFailure : null;
}

export function mcpToolFailureMessage(failure: McpToolFailure): string { return messages[failure]; }

export function isMcpToolFailureMessage(value: unknown): value is string {
  return typeof value === "string" && Object.values(messages).some(message => message === value);
}
