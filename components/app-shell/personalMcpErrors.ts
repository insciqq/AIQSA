import { MCP_RUN_PLAN_LIMITS, PERSONAL_MCP_CONNECTION_LIMIT } from "@/lib/contracts/mcp";
import { PersonalMcpApiError, type PersonalMcpAuthMode } from "./personalMcpApi";

/** Inputs of the add and replace-token forms that an error can belong to. */
export type PersonalMcpField = "auth" | "headerName" | "insecure" | "name" | "token" | "url";

export type PersonalMcpErrorPresentation = Readonly<{
  fields: Partial<Record<PersonalMcpField, string>>;
  general: string | null;
}>;

export const PERSONAL_MCP_LOCAL_ADDRESS_HINT =
  "Here, localhost means the AIQSA server itself. Reach your own computer through host.docker.internal or its LAN IP address.";

const unreachable = "AIQSA could not reach this server. Check the URL and that the server is running.";
const headerName = "Use a header name such as X-API-Key. Host, Cookie and connection headers are not allowed.";

/**
 * One copy table for the stable codes of create, credential replacement and
 * validation issues. Upstream status, operation and endpoint never appear.
 */
const COPY: Readonly<Record<string, readonly [PersonalMcpField | null, string]>> = {
  auth_mode_invalid: ["auth", "Choose how this server is authorized."],
  authorization_required: ["token", "Enter the token or API key."],
  forbidden: [null, "Your account cannot manage connections."],
  header_name_invalid: ["headerName", headerName],
  insecure_http_acknowledgement_required: ["insecure", "Confirm that this connection is unencrypted, or use an https:// URL."],
  invalid_mcp_values: [null, "Check the connection details and try again."],
  mcp_authorization_required: ["token", "The server rejected this token or API key."],
  mcp_connect_failed: ["url", unreachable],
  mcp_connection_forbidden: ["url", "AIQSA is not allowed to connect to this address."],
  mcp_draft_changed: [null, "This connection changed meanwhile. Try again."],
  mcp_draft_test_failed: [null, "AIQSA could not connect to this server with these details. Check the URL and authorization."],
  mcp_enabled_server_limit_reached: [null, `At most ${MCP_RUN_PLAN_LIMITS.maxEnabledServers} MCP servers can be on at once, including Studio's MCP servers. Turn one off first.`],
  mcp_encryption_unavailable: [null, "Credential storage is unavailable right now. Ask the administrator to check it."],
  mcp_internal_address_forbidden: ["url", `This address belongs to AIQSA's own services, so it cannot be used. ${PERSONAL_MCP_LOCAL_ADDRESS_HINT}`],
  mcp_local_network_disabled: ["url", "The administrator turned off connections to the local network. Use a public address or ask the administrator."],
  mcp_network_failed: ["url", unreachable],
  mcp_not_found: [null, "This connection no longer exists. Refresh the list."],
  mcp_oauth_discovery_failed: ["url", "This server did not publish OAuth sign-in details. Check the URL or choose another authorization type."],
  mcp_oauth_insecure_endpoint: ["url", "This server signs in through an unencrypted http:// address. AIQSA never sends an https:// server's sign-in over http://."],
  mcp_request_timeout: ["url", unreachable],
  mcp_static_header_duplicate: ["headerName", headerName],
  mcp_static_header_invalid: ["headerName", headerName],
  mcp_static_header_reserved: ["headerName", headerName],
  mcp_timeout: ["url", unreachable],
  mcp_tls_failed: ["url", "The server's TLS certificate could not be verified."],
  mcp_unavailable: [null, "Connections are unavailable right now. Try again later."],
  mcp_validation_unavailable: [null, "Connection checks are unavailable right now. Try again later."],
  personal_mcp_limit_reached: [null, `You already have ${PERSONAL_MCP_CONNECTION_LIMIT} personal connections. Disconnect one to add another.`],
  unauthorized: [null, "Your session ended. Sign in again."],
  url_invalid: ["url", "Enter an https:// or http:// URL without a user name, password, query or fragment."],
  url_required: ["url", "Enter the server URL."]
};

/** Codes that only wrap their issues. */
const WRAPPERS = new Set(["invalid_draft", "invalid_mcp_values", "mcp_draft_test_failed"]);

function fieldForPath(path: string): PersonalMcpField | null {
  if (path === "url" || path === "source" || path.startsWith("source.")) return "url";
  if (path === "name") return "name";
  if (path === "auth.mode") return "auth";
  if (path === "auth.headerName" || path === "credentials.headerName") return "headerName";
  if (path === "values" || path === "values.authorization" || path === "oneTimeValues.authorization" ||
    path === "credentials.authorization") return "token";
  if (path === "insecureHttpAcknowledged") return "insecure";
  return null;
}

export function formatRetryAfter(seconds: number | null): string {
  if (!seconds) return "a few minutes";
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Maps a create or credential-replacement failure to field-associated copy.
 * Fields outside `fields` (for example the URL while replacing a token) fall
 * back to the general message.
 */
export function presentPersonalMcpError(
  error: unknown,
  context: Readonly<{ authMode: PersonalMcpAuthMode; fields: readonly PersonalMcpField[]; fallback: string }>
): PersonalMcpErrorPresentation {
  if (!(error instanceof PersonalMcpApiError)) return { fields: {}, general: context.fallback };
  if (error.code === "personal_mcp_rate_limited") {
    return { fields: {}, general: `Too many attempts. Try again in ${formatRetryAfter(error.retryAfterSeconds)}.` };
  }
  const fields: Partial<Record<PersonalMcpField, string>> = {};
  const allowed = new Set(context.fields);
  let general: string | null = null;
  const place = (code: string, path: string | null) => {
    const entry = COPY[code];
    // The code names its input; the issue path places codes that do not.
    let field = entry?.[0] ?? (path ? fieldForPath(path) : null);
    // A rejected credential belongs to the token only when there is one.
    if (code === "mcp_authorization_required" && context.authMode !== "static") field = allowed.has("auth") ? "auth" : null;
    const text = code === "mcp_authorization_required" && context.authMode !== "static"
      ? "This server requires authorization. Choose OAuth or a token."
      : entry?.[1] ?? null;
    if (!text) return false;
    if (field && allowed.has(field)) {
      fields[field] ??= text;
    } else {
      general ??= text;
    }
    return true;
  };
  let placedIssue = false;
  for (const issue of error.issues) placedIssue = place(issue.code, issue.path) || placedIssue;
  if (!placedIssue || !WRAPPERS.has(error.code)) {
    if (!(error.issues.some((issue) => issue.code === error.code)) && !place(error.code, null)) general ??= context.fallback;
  }
  if (!general && Object.keys(fields).length === 0) general = context.fallback;
  return { fields, general };
}

/** OAuth start (Connect / Reconnect) failures shown on the connection's row. */
export function presentPersonalMcpOAuthStartError(error: unknown): Readonly<{ readd: boolean; text: string }> {
  const failure = error instanceof Error ? error as Error & { code?: unknown; retryAfterSeconds?: unknown } : null;
  const code = typeof failure?.code === "string" ? failure.code : null;
  if (code === "personal_mcp_rate_limited") {
    const seconds = typeof failure?.retryAfterSeconds === "number" ? failure.retryAfterSeconds : null;
    return { readd: false, text: `Too many authorization attempts. Try again in ${formatRetryAfter(seconds)}.` };
  }
  if (code === "mcp_oauth_policy_forbidden" || code === "mcp_oauth_discovery_failed" ||
    code === "mcp_oauth_configuration_changed" || code === "mcp_oauth_insecure_endpoint") {
    return {
      readd: true,
      text: "This server's sign-in details changed since it was added, so it cannot be reconnected. Disconnect it and add it again."
    };
  }
  if (code === "mcp_oauth_not_available" || code === "mcp_not_found") {
    return { readd: false, text: "This connection no longer exists. Refresh the list." };
  }
  return { readd: false, text: "Authorization could not be started. Try again." };
}
