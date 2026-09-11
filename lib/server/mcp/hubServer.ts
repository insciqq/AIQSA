import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpHubDiscoveryResult } from "@/lib/contracts/mcpHub";
import { createMcpHubService, McpHubServiceError, type McpHubAuthority } from "./hubService";
import { MCP_HUB_REQUEST_DEADLINE_MS } from "./hubConfiguration";
export { MCP_HUB_REQUEST_DEADLINE_MS } from "./hubConfiguration";
const findToolsInput = z.strictObject({
  goal: z.string().trim().min(1).max(400)
}, { error: "invalid_arguments" });
const callToolInput = z.strictObject({
  tool_id: z.string().trim().min(1).max(128),
  tool_version: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown())
}, { error: "invalid_arguments" });

function result(value: Readonly<Record<string, unknown>>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function errorResult(error: unknown): CallToolResult {
  const code = error instanceof McpHubServiceError ? error.code : "upstream_unavailable";
  const message = code === "authorization_required"
    ? "Reconnect this app to AIQSA MCP Hub and approve access."
    : code === "execution_outcome_unknown"
      ? "The operation may have executed. Check its outcome before attempting it again."
      : code === "tool_definition_changed"
        ? "Use find_tools again to obtain the current tool definition."
        : code === "upstream_unavailable"
          ? "Check the connection and sign-in status in AIQSA MCP settings."
          : code === "discovery_unavailable"
            ? "Tool discovery is unavailable. Ask an administrator to check the System Model."
            : code === "tool_unavailable"
              ? "This tool is unavailable with your current permissions and enabled connections."
              : code === "result_unsupported"
                ? "The operation returned a result this Hub cannot deliver. Do not repeat a write to change its output format."
                : code === "request_cancelled" ? "The request was cancelled before dispatch."
                  : "Check the arguments against the tool's current input schema.";
  return result({ code, message }, true);
}

function bounded<T>(
  operation: (signal: AbortSignal, onDispatch: () => void) => Promise<T>,
  signal: AbortSignal,
  deadlineMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let dispatched = false;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => {
      controller.abort();
      finish(() => reject(new McpHubServiceError(dispatched ? "execution_outcome_unknown" : "request_cancelled")));
    };
    const timer = setTimeout(abort, deadlineMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else operation(controller.signal, () => { dispatched = true; })
      .then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

export function createMcpHubServer(input: Readonly<{
  service: ReturnType<typeof createMcpHubService>;
  authority: McpHubAuthority;
  deadlineMs?: number;
}>): McpServer {
  const deadlineMs = input.deadlineMs ?? MCP_HUB_REQUEST_DEADLINE_MS;
  const server = new McpServer({ name: "aiqsa-mcp-hub", version: "1.0.0" }, {
    instructions: "Use find_tools with the user's goal, then call_tool with the returned tool_id, tool_version, and arguments. Tools are limited by the user's current AIQSA permissions and enabled MCP connections."
  });
  server.registerTool("find_tools", {
    annotations: { readOnlyHint: true, idempotentHint: true },
    description: "Find enabled MCP tools that can help with a goal. This performs bounded semantic discovery and does not call a business tool.",
    inputSchema: findToolsInput
  }, (argumentsValue, context) => bounded(
    (signal) => input.service.findTools({
      authority: input.authority,
      goal: argumentsValue.goal,
      signal,
      timeoutMs: deadlineMs
    }).then((value: McpHubDiscoveryResult) => result(value)),
    context.mcpReq.signal,
    deadlineMs
  ).catch(errorResult));
  server.registerTool("call_tool", {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    description: "Call one exact MCP tool returned by find_tools. Recheck the current authorization and tool definition before dispatch; write operations are not automatically retried.",
    inputSchema: callToolInput
  }, (argumentsValue, context) => bounded(async (signal, onDispatch) => {
    const prepared = await input.service.prepareToolCall({
      authority: input.authority,
      arguments: argumentsValue.arguments,
      signal,
      toolId: argumentsValue.tool_id,
      toolVersion: argumentsValue.tool_version
    });
    const value = await input.service.dispatchPreparedToolCall({
      authority: input.authority,
      onDispatch,
      prepared,
      signal
    });
    return {
      content: value.text.map((text) => ({ type: "text" as const, text })),
      ...(value.structuredContent ? { structuredContent: value.structuredContent } : {}),
      ...(value.isError ? { isError: true } : {})
    } satisfies CallToolResult;
  }, context.mcpReq.signal, deadlineMs).catch(errorResult));
  return server;
}
