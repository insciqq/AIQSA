/** Closed, content-free diagnostics shared by the router, MCP clients and UI. */
export const MCP_DISCOVERY_FAILURE_MESSAGES = {
  mcp_router_cancelled: "the request was cancelled",
  mcp_router_output_limit: "the System Model exhausted its output allowance",
  mcp_router_model_output_limit: "the configured output allowance exceeds the System Model's limit",
  mcp_router_context_limit: "the System Model has no output space left after the tool catalog and context",
  mcp_router_timeout: "the System Model did not finish before the deadline",
  mcp_router_credential_unavailable: "the System Model's credential is unavailable",
  mcp_router_output_invalid: "the System Model returned an invalid tool selection",
  mcp_router_request_failed: "the System Model request failed",
  mcp_router_request_rejected: "the provider rejected the System Model request",
  mcp_router_gemini_invalid_request: "the provider rejected the request format",
  mcp_router_gemini_parameter_unknown: "the provider rejected a request parameter",
  mcp_router_structured_output_unverified: "structured output is not verified for the System Model",
  mcp_router_system_model_absent: "no System Model is assigned",
  mcp_router_system_model_unavailable: "the assigned System Model is unavailable",
  mcp_router_invalid_shape: "the tool selection has missing, extra or incorrectly typed fields",
  mcp_router_invalid_outcome: "a routing outcome is empty, too long or contains invalid whitespace",
  mcp_router_duplicate_outcome: "the tool selection repeats a routing outcome",
  mcp_router_invalid_coverage: "an outcome's coverage status contradicts its selected tools",
  mcp_router_tool_limit: "the tool selection exceeds the admitted tool limit",
  mcp_router_unknown_tool: "the tool selection contains an identifier outside the available catalog",
  mcp_router_duplicate_tool: "a routing outcome repeats a tool identifier",
  mcp_router_empty_output: "the System Model returned no JSON result",
  mcp_router_invalid_json: "the System Model returned malformed JSON",
  mcp_router_non_object: "the System Model returned a JSON value instead of an object",
  mcp_router_invalid_wrapper: "the provider's structured response wrapper is invalid",
  mcp_router_response_incomplete: "the provider returned an incomplete response",
  mcp_router_response_invalid: "the provider returned an invalid response envelope"
} as const;

export type McpDiscoveryFailureReason = keyof typeof MCP_DISCOVERY_FAILURE_MESSAGES;
export type McpDiscoveryFailure = Readonly<{
  reason: McpDiscoveryFailureReason;
  detail?: McpDiscoveryFailureReason;
  attempt?: number;
}>;

function known(value: unknown): value is McpDiscoveryFailureReason {
  return typeof value === "string" && Object.hasOwn(MCP_DISCOVERY_FAILURE_MESSAGES, value);
}

export function decodeMcpDiscoveryFailure(value: unknown): McpDiscoveryFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!known(record.reason) || record.detail !== undefined && !known(record.detail) ||
    record.attempt !== undefined && record.attempt !== 1 && record.attempt !== 2) return null;
  return { reason: record.reason, ...(known(record.detail) ? { detail: record.detail } : {}),
    ...(typeof record.attempt === "number" ? { attempt: record.attempt } : {}) };
}

export function mcpDiscoveryFailureMessage(failure: McpDiscoveryFailure): string {
  return `Tool discovery failed: ${MCP_DISCOVERY_FAILURE_MESSAGES[failure.detail ?? failure.reason]}.`;
}

export function isMcpDiscoveryFailureMessage(value: unknown): value is string {
  return typeof value === "string" && Object.values(MCP_DISCOVERY_FAILURE_MESSAGES)
    .some(message => value === `Tool discovery failed: ${message}.`);
}
