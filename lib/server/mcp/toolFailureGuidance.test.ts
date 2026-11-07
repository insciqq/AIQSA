import { Client, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClientSession, McpClientSessionError } from "./clientSession";
import { mcpDispatchError } from "./dispatchStatus";
import { mcpToolFailureGuidance } from "./toolFailureGuidance";

const READ_ONLY = "The tool only reads, so nothing changed.";
const NOT_SENT = "Nothing was sent, so nothing changed.";

function sessionError(input: ConstructorParameters<typeof McpClientSessionError>[0]): McpClientSessionError {
  return new McpClientSessionError(input);
}

describe("MCP tool failure guidance", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["result_too_large", sessionError({ code: "mcp_call_result_too_large", maxBytes: 16 * 1_048_576, operation: "call_tool" }),
      "The MCP tool's response was larger than the 16 MB limit and was not read. " + READ_ONLY +
      " The same call will fail the same way: ask for less, such as fewer items, a narrower query or filter, fewer fields, or " +
      "the next page, and read one item instead of a whole collection or thread."],
    ["timeout", sessionError({ code: "mcp_request_timeout", operation: "call_tool", retryable: true, timeoutMs: 120_000 }),
      "The MCP server did not answer within 120 s. " + READ_ONLY +
      " Narrow the request (fewer items, a shorter range) or try again later; do not repeat the same call right away."],
    ["server_error", sessionError({ code: "mcp_call_failed", httpStatus: 503, operation: "call_tool", retryable: true }),
      "The MCP server returned a server error (HTTP 5xx). " + READ_ONLY +
      " Do not repeat the same call in this answer; try a different, narrower request once, or continue without this tool " +
      "and tell the user it failed."],
    ["rate_limited", sessionError({ code: "mcp_call_failed", httpStatus: 429, operation: "call_tool", retryable: true }),
      "The MCP server is limiting requests (HTTP 429). " + READ_ONLY +
      " Make fewer calls and wait before calling it again; do not repeat the same call right away."],
    ["rejected", sessionError({ code: "mcp_call_failed", httpStatus: 404, operation: "call_tool" }),
      "The MCP server rejected the request (HTTP 4xx). " + READ_ONLY +
      " Check the arguments against the tool's description; do not repeat the same call unchanged."],
    ["unavailable", sessionError({ code: "mcp_session_closed", operation: "call_tool" }),
      "The MCP server is unavailable or not ready. " + READ_ONLY +
      " Do not retry its tools in this answer; continue without them and tell the user."],
    ["authorization", sessionError({ code: "mcp_authorization_required", httpStatus: 401, operation: "call_tool" }),
      "The MCP server did not accept the connection's authorization. " + READ_ONLY +
      " Do not retry it in this answer: the user must reconnect the server in MCP settings, or an administrator must check " +
      "its credentials."],
    ["invalid_result", sessionError({ code: "mcp_call_result_invalid", operation: "call_tool" }),
      "The MCP server returned a response that breaks the MCP protocol or holds no supported content. " + READ_ONLY +
      " Do not repeat the same call; try a different request or continue without this tool."],
    ["arguments_invalid", sessionError({ code: "mcp_call_arguments_invalid", operation: "call_tool" }),
      "The arguments do not match the tool's input schema or exceed its size limit. " + READ_ONLY +
      " Correct the arguments before calling the tool again."],
    ["server_failed", sessionError({ code: "mcp_call_failed", operation: "call_tool", retryable: true }),
      "The MCP call failed without a usable result. " + READ_ONLY +
      " Check the arguments against the tool's description; do not repeat the same call unchanged."]
  ] as const)("tells the model why a read-only call failed and what to do next: %s", (reason, error, message) => {
    expect(mcpToolFailureGuidance(error, "read_only")).toEqual({ message, reason });
  });

  it("names a refusal before dispatch as not sent, with its cause", () => {
    expect(mcpToolFailureGuidance(mcpDispatchError("mcp_runtime_unavailable"), "not_sent")).toEqual({ reason: "unavailable",
      message: `The MCP server is unavailable or not ready. ${NOT_SENT} Do not retry its tools in this answer; continue without ` +
        "them and tell the user." });
    expect(mcpToolFailureGuidance(mcpDispatchError("mcp_authorization_required"), "not_sent").reason).toBe("authorization");
    expect(mcpToolFailureGuidance(mcpDispatchError("memory_egress_destination_revoked"), "not_sent").reason).toBe("unavailable");
    expect(mcpToolFailureGuidance(mcpDispatchError("mcp_tool_disabled"), "not_sent")).toEqual({ reason: "tool_disabled",
      message: `This MCP tool is switched off or no longer available to the user. ${NOT_SENT} Do not call it again in this answer.` });
    expect(mcpToolFailureGuidance(mcpDispatchError("mcp_tool_definition_changed"), "not_sent")).toEqual({
      reason: "configuration_changed",
      message: "The MCP server or this tool changed after this answer started, so it cannot be used in this answer. " +
        `${NOT_SENT} Do not call it again in this answer; the user can send a new message to use the current configuration.` });
    // The runtime that is not running yet throws its own coded error.
    expect(mcpToolFailureGuidance(Object.assign(new Error("mcp_runtime_not_ready"), { code: "mcp_runtime_not_ready" }), "not_sent")
      .reason).toBe("unavailable");
  });

  it("falls back to plain words when a bound is missing, and never reads an error's message", () => {
    expect(mcpToolFailureGuidance(sessionError({ code: "mcp_call_result_too_large", operation: "call_tool" }), "read_only").message)
      .toMatch(/^The MCP tool's response was larger than its size limit and was not read\./u);
    expect(mcpToolFailureGuidance(sessionError({ code: "mcp_request_timeout", operation: "call_tool" }), "read_only").message)
      .toMatch(/^The MCP server did not answer within its time limit\./u);
    expect(mcpToolFailureGuidance(sessionError({ code: "mcp_call_result_too_large", maxBytes: 512 * 1_024, operation: "call_tool" }),
      "read_only").message).toContain("larger than the 512 KB limit");
    // Text that only looks like a cause decides nothing.
    const worded = new Error("timeout 401 unauthorized response too large");
    expect(mcpToolFailureGuidance(worded, "read_only").reason).toBe("server_failed");
    const odd = Object.assign(new Error("x"), { code: "https://PRIVATE_URL_CANARY.example/mcp" });
    expect(mcpToolFailureGuidance(odd, "read_only").reason).toBe("server_failed");
  });

  it("leaks no endpoint, credential, header, argument or raw server text from real session failures", async () => {
    vi.spyOn(Client.prototype, "connect").mockResolvedValue();
    vi.spyOn(Client.prototype, "getServerVersion").mockReturnValue({ name: "PRIVATE_SERVER_CANARY", version: "1.0.0" });
    vi.spyOn(Client.prototype, "getServerCapabilities").mockReturnValue({ tools: {} });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const session = new McpClientSession({
      url: new URL("https://PRIVATE_URL_CANARY.example/mcp?key=PRIVATE_QUERY_CANARY"), fetch: vi.fn(),
      headers: { authorization: "Bearer PRIVATE_TOKEN_CANARY", "x-api-key": "PRIVATE_HEADER_CANARY" }, requestTimeoutMs: 45_000,
      limits: { maxListDurationMs: 10_000, maxToolArgumentBytes: 1_024, maxToolMetadataBytes: 2_048, maxToolResultBytes: 2_048,
        maxToolSchemaBytes: 2_048, maxTools: 16 }
    });
    await session.initialize();
    const call = vi.spyOn(Client.prototype, "callTool");
    const failures = [
      new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "PRIVATE_SERVER_TEXT_CANARY at https://PRIVATE_URL_CANARY.example/mcp",
        { status: 502, statusText: "PRIVATE_STATUS_CANARY", body: "PRIVATE_BODY_CANARY" }),
      new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "PRIVATE_SERVER_TEXT_CANARY", { status: 429 }),
      new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "PRIVATE_SERVER_TEXT_CANARY", { status: 401 }),
      new ProtocolError(ProtocolErrorCode.InternalError, "PRIVATE_SERVER_TEXT_CANARY: Bearer PRIVATE_TOKEN_CANARY",
        { trace: "PRIVATE_DATA_CANARY" }),
      new SdkError(SdkErrorCode.RequestTimeout, "PRIVATE_TIMEOUT_CANARY"),
      new TypeError("fetch failed: PRIVATE_URL_CANARY.example PRIVATE_SERVER_TEXT_CANARY")
    ];
    const seen: string[] = [];
    for (const failure of failures) {
      call.mockRejectedValueOnce(failure);
      const error = await session.callTool("search_threads", { query: "PRIVATE_ARGUMENT_CANARY" }).catch((thrown: unknown) => thrown);
      const guidance = mcpToolFailureGuidance(error, "read_only");
      seen.push(guidance.reason);
      expect(guidance.message.length).toBeLessThan(400);
      expect(JSON.stringify(guidance)).not.toMatch(/PRIVATE_|https?:|Bearer|search_threads/u);
    }
    expect(seen).toEqual(["server_error", "rate_limited", "authorization", "server_failed", "timeout", "server_failed"]);
    call.mockRejectedValueOnce(new SdkError(SdkErrorCode.RequestTimeout, "PRIVATE_TIMEOUT_CANARY"));
    const timedOut = await session.callTool("slow", {}, { timeoutMs: 30_000 }).catch((thrown: unknown) => thrown);
    expect(mcpToolFailureGuidance(timedOut, "read_only").message).toMatch(/^The MCP server did not answer within 30 s\./u);
  });
});
