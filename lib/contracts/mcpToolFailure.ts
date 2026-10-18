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

/** Rounded down, so "larger than" stays true of the bound itself. */
function byteBound(bytes: number): string {
  const [unit, size]: readonly [string, number] = bytes >= 1_048_576 ? ["MiB", 1_048_576]
    : bytes >= 1_024 ? ["KiB", 1_024] : ["bytes", 1];
  return `${Math.floor(bytes / size * 10) / 10} ${unit}`;
}

/**
 * What a model reads when a tool's response exceeded the byte bound, so the
 * call failed unread: how to ask for less. It names no tool or server.
 */
export function mcpOversizedResponseMessage(maxBytes?: number): string {
  const size = maxBytes !== undefined && Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? `larger than ${byteBound(maxBytes)}` : "too large";
  return `${messages.mcp_call_result_too_large} The tool was called, but its response was ${size} and was not read; ` +
    "the same call is likely to fail the same way. Request less data: narrow the query, request fewer records or fields, " +
    "read a single item instead of a whole collection or thread, or ask for plain text instead of raw or HTML formats. " +
    "Do not repeat a write solely because its response could not be read.";
}
