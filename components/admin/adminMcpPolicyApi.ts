import { decodeMcpPolicyResponse, type McpPolicyUpdateRequest, type McpPolicyWire } from "@/lib/contracts/mcpPolicy";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AdminMcpPolicyResult =
  | Readonly<{ data: McpPolicyWire; ok: true }>
  | Readonly<{ error: string; ok: false }>;

const POLICY_PATH = "/api/admin/mcp/policy";

async function request(init: RequestInit, fetcher: Fetcher): Promise<AdminMcpPolicyResult> {
  try {
    const response = await fetcher(POLICY_PATH, { cache: "no-store", credentials: "same-origin", ...init });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : "mcp_policy_failed";
      return { error, ok: false };
    }
    const policy = decodeMcpPolicyResponse(value);
    return policy ? { data: policy, ok: true } : { error: "mcp_policy_response_invalid", ok: false };
  } catch {
    return { error: "network_error", ok: false };
  }
}

export function getAdminMcpPolicy(fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<AdminMcpPolicyResult> {
  return request({ method: "GET", ...(signal ? { signal } : {}) }, fetcher);
}

/** Replaces the policy at the version the caller read; a concurrent change answers `mcp_policy_stale`. */
export function updateAdminMcpPolicy(
  body: McpPolicyUpdateRequest,
  fetcher: Fetcher = fetch
): Promise<AdminMcpPolicyResult> {
  return request({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  }, fetcher);
}

export function adminMcpPolicyErrorMessage(code: string, operation: "read" | "update" = "update"): string {
  const messages: Record<string, string> = {
    forbidden: "Your account can no longer manage MCP servers.",
    mcp_policy_failed: "The personal connection setting could not be loaded.",
    mcp_policy_input_invalid: "The personal connection setting change was not accepted.",
    mcp_policy_response_invalid: "The personal connection setting response was invalid. Refresh and try again.",
    mcp_policy_stale: "This setting changed in another session. The current value is shown; try again if needed.",
    mcp_policy_unavailable: "The personal connection setting is temporarily unavailable. Try again.",
    network_error: "The personal connection setting could not be reached.",
    unauthorized: "Your administrator session has expired. Sign in again to continue."
  };
  return messages[code] ?? (operation === "read"
    ? "The personal connection setting could not be loaded."
    : "The personal connection setting could not be updated.");
}
