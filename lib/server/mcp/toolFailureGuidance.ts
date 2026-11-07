import { McpClientSessionError } from "./clientSession";

/**
 * Why an MCP call failed, as the model reads it: a closed class picked from the
 * error's own code, HTTP status and bounds, never from its message. Raw server
 * text, endpoints, headers, credentials and arguments never reach the text.
 */
export type McpToolFailureReason =
  | "arguments_invalid"
  | "authorization"
  | "configuration_changed"
  | "invalid_result"
  | "rate_limited"
  | "rejected"
  | "result_too_large"
  | "server_error"
  | "server_failed"
  | "timeout"
  | "tool_disabled"
  | "unavailable";

/**
 * What is known of the call's effect, stated after the reason: a read-only
 * tool's failure changed nothing, and neither did a call refused before it
 * was sent. A write whose outcome is unknown never gets this guidance; it
 * keeps the batch's unknown-outcome text and is never sent again
 * (`agent_docs/RUN_CONTRACTS.md`, Answer first).
 */
export type McpToolFailureEffect = "not_sent" | "read_only";

export type McpToolFailureGuidance = Readonly<{ message: string; reason: McpToolFailureReason }>;

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "mcp_connect_failed", "mcp_connection_forbidden", "mcp_health_check_failed", "mcp_internal_address_forbidden",
  "mcp_local_network_disabled", "mcp_network_failed", "mcp_runtime_not_ready",
  "mcp_runtime_unavailable", "mcp_session_closed", "mcp_session_not_ready", "mcp_tls_failed", "mcp_tool_not_available",
  "memory_egress_destination_revoked"
]);
const CHANGED_CODES: ReadonlySet<string> = new Set([
  "mcp_accepted_generation_changed", "mcp_inventory_changed", "mcp_tool_definition_changed"
]);
const TOO_LARGE_CODES: ReadonlySet<string> = new Set(["mcp_call_result_too_large", "mcp_response_too_large"]);

type Facts = Readonly<{ code: string | undefined; httpStatus?: number; maxBytes?: number; timeoutMs?: number }>;

function ownCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !Object.hasOwn(error, "code")) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function facts(error: unknown): Facts {
  if (!McpClientSessionError.isInstance(error)) return { code: ownCode(error) };
  return {
    code: error.code,
    httpStatus: boundedInteger(error.httpStatus, 400, 599),
    maxBytes: boundedInteger(error.maxBytes, 1, Number.MAX_SAFE_INTEGER),
    timeoutMs: boundedInteger(error.timeoutMs, 1, Number.MAX_SAFE_INTEGER)
  };
}

/** Rounded down, so "larger than" stays true of the bound itself; a MiB bound reads as that many MB. */
function sizeLimit(bytes: number): string {
  const [unit, size]: readonly [string, number] = bytes >= 1_048_576 ? ["MB", 1_048_576] : bytes >= 1_024 ? ["KB", 1_024] : ["bytes", 1];
  return `${Math.floor(bytes / size * 10) / 10} ${unit}`;
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1_000))} s`;
}

function classify(failure: Facts): McpToolFailureReason {
  const code = failure.code;
  if (code && TOO_LARGE_CODES.has(code)) return "result_too_large";
  if (code === "mcp_request_timeout" || code === "mcp_timeout") return "timeout";
  if (code === "mcp_authorization_required" || failure.httpStatus === 401 || failure.httpStatus === 403) return "authorization";
  if (code === "mcp_call_result_invalid" || code === "mcp_call_result_unsupported") return "invalid_result";
  if (code === "mcp_call_arguments_invalid" || code === "mcp_call_arguments_too_large") return "arguments_invalid";
  if (code === "mcp_tool_disabled" || code === "mcp_tool_access_denied") return "tool_disabled";
  if (code && CHANGED_CODES.has(code)) return "configuration_changed";
  if (code && UNAVAILABLE_CODES.has(code)) return "unavailable";
  if (failure.httpStatus === 429) return "rate_limited";
  if (failure.httpStatus !== undefined && failure.httpStatus >= 500) return "server_error";
  if (failure.httpStatus !== undefined) return "rejected";
  return "server_failed";
}

function reasonText(reason: McpToolFailureReason, failure: Facts): readonly [why: string, next: string] {
  switch (reason) {
    case "result_too_large":
      return [`The MCP tool's response was larger than ${failure.maxBytes ? `the ${sizeLimit(failure.maxBytes)} limit` : "its size limit"} ` +
        "and was not read.",
      "The same call will fail the same way: ask for less, such as fewer items, a narrower query or filter, fewer fields, or " +
        "the next page, and read one item instead of a whole collection or thread."];
    case "timeout":
      return [`The MCP server did not answer within ${failure.timeoutMs ? seconds(failure.timeoutMs) : "its time limit"}.`,
        "Narrow the request (fewer items, a shorter range) or try again later; do not repeat the same call right away."];
    case "server_error":
      return ["The MCP server returned a server error (HTTP 5xx).",
        "Do not repeat the same call in this answer; try a different, narrower request once, or continue without this tool " +
        "and tell the user it failed."];
    case "rate_limited":
      return ["The MCP server is limiting requests (HTTP 429).",
        "Make fewer calls and wait before calling it again; do not repeat the same call right away."];
    case "rejected":
      return ["The MCP server rejected the request (HTTP 4xx).",
        "Check the arguments against the tool's description; do not repeat the same call unchanged."];
    case "unavailable":
      return ["The MCP server is unavailable or not ready.",
        "Do not retry its tools in this answer; continue without them and tell the user."];
    case "authorization":
      return ["The MCP server did not accept the connection's authorization.",
        "Do not retry it in this answer: the user must reconnect the server in MCP settings, or an administrator must check " +
        "its credentials."];
    case "invalid_result":
      return ["The MCP server returned a response that breaks the MCP protocol or holds no supported content.",
        "Do not repeat the same call; try a different request or continue without this tool."];
    case "arguments_invalid":
      return ["The arguments do not match the tool's input schema or exceed its size limit.",
        "Correct the arguments before calling the tool again."];
    case "tool_disabled":
      return ["This MCP tool is switched off or no longer available to the user.", "Do not call it again in this answer."];
    case "configuration_changed":
      return ["The MCP server or this tool changed after this answer started, so it cannot be used in this answer.",
        "Do not call it again in this answer; the user can send a new message to use the current configuration."];
    case "server_failed":
      return ["The MCP call failed without a usable result.",
        "Check the arguments against the tool's description; do not repeat the same call unchanged."];
  }
}

/**
 * The model's text for an MCP call that failed with a known effect: why, that
 * nothing changed, and what to do next. Only closed fields of the error choose
 * the words; the error's message, which may carry server text, is never read.
 */
export function mcpToolFailureGuidance(error: unknown, effect: McpToolFailureEffect): McpToolFailureGuidance {
  const failure = facts(error);
  const reason = classify(failure);
  const [why, next] = reasonText(reason, failure);
  const changed = effect === "read_only" ? "The tool only reads, so nothing changed." : "Nothing was sent, so nothing changed.";
  return { message: `${why} ${changed} ${next}`, reason };
}
