/** The installation-wide MCP policy singleton. */
export const MCP_POLICY_ID = "installation";

/**
 * Administrator policy for personal MCP. `version` is the optimistic
 * concurrency token: a PATCH names the version it read.
 */
export type McpPolicyWire = Readonly<{
  personalLocalNetworkEnabled: boolean;
  version: number;
}>;

export type McpPolicyResponseWire = Readonly<{ policy: McpPolicyWire }>;

/** PATCH `/api/admin/mcp/policy`: the new value and the version it replaces. */
export type McpPolicyUpdateRequest = Readonly<{
  personalLocalNetworkEnabled: boolean;
  version: number;
}>;

export type McpPolicyErrorCode =
  | "forbidden"
  | "json_required"
  | "mcp_policy_input_invalid"
  | "mcp_policy_stale"
  | "mcp_policy_unavailable"
  | "unauthorized";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMcpPolicyVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function decodeMcpPolicyResponse(value: unknown): McpPolicyWire | null {
  if (!isRecord(value) || !isRecord(value.policy)) return null;
  const { personalLocalNetworkEnabled, version } = value.policy;
  return typeof personalLocalNetworkEnabled === "boolean" && isMcpPolicyVersion(version)
    ? { personalLocalNetworkEnabled, version }
    : null;
}
