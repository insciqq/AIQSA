import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { McpHubDiscoveryResult } from "@/lib/contracts/mcpHub";
import { createMcpHubService, McpHubServiceError } from "./hubService";

export const MCP_HUB_REQUEST_DEADLINE_MS = 30_000;
const findToolsInput = z.object({
  goal: z.string().trim().min(1).max(400),
  context: z.string().max(8_000).optional()
}).strict();
const callToolInput = z.object({
  tool_id: z.string().trim().min(1).max(128),
  tool_version: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown())
}).strict();

function result(value: Readonly<Record<string, unknown>>, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function errorResult(error: unknown): CallToolResult {
  const code = error instanceof McpHubServiceError ? error.code : "upstream_unavailable";
  return result({ code }, true);
}

function bounded<T>(operation: () => Promise<T>, signal: AbortSignal, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => finish(() => reject(new McpHubServiceError("request_cancelled")));
    const timer = setTimeout(() => finish(() => reject(new McpHubServiceError("upstream_unavailable"))), deadlineMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else operation().then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

export function createMcpHubServer(input: Readonly<{
  service: ReturnType<typeof createMcpHubService>;
  userId: string;
  deadlineMs?: number;
}>): McpServer {
  const deadlineMs = input.deadlineMs ?? MCP_HUB_REQUEST_DEADLINE_MS;
  const server = new McpServer({ name: "aiqsa-mcp-hub", version: "1.0.0" }, {
    instructions: "Use find_tools with the user's goal, then call_tool with the returned tool_id, tool_version, and arguments. Tools are limited by the user's current AIQSA permissions and enabled MCP connections."
  });
  server.registerTool("find_tools", {
    description: "Find enabled MCP tools that can help with a goal. This performs bounded semantic discovery and does not call a business tool.",
    inputSchema: findToolsInput
  }, (argumentsValue, context) => bounded(
    () => input.service.findTools({
      ...(argumentsValue.context ? { context: argumentsValue.context } : {}),
      goal: argumentsValue.goal,
      userId: input.userId
    }).then((value: McpHubDiscoveryResult) => result(value)),
    context.mcpReq.signal,
    deadlineMs
  ).catch(errorResult));
  server.registerTool("call_tool", {
    description: "Call one exact MCP tool returned by find_tools. Recheck the current authorization and tool definition before dispatch; write operations are not automatically retried.",
    inputSchema: callToolInput
  }, (argumentsValue, context) => bounded(async () => {
    const prepared = await input.service.prepareToolCall({
      arguments: argumentsValue.arguments,
      toolId: argumentsValue.tool_id,
      toolVersion: argumentsValue.tool_version,
      userId: input.userId
    });
    const value = await input.service.dispatchPreparedToolCall({
      prepared,
      signal: context.mcpReq.signal,
      userId: input.userId
    });
    return result({
      content: value.text,
      ...(value.structuredContent ? { structuredContent: value.structuredContent } : {}),
      isError: value.isError,
      unsupportedContentTypes: value.unsupportedContentTypes
    }, value.isError);
  }, context.mcpReq.signal, deadlineMs).catch(errorResult));
  return server;
}
