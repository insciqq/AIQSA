import type { AiqsaMcpToolCallResult } from "./clientSession";
import type { McpRunPlanSnapshot, McpRunPlanTool } from "./runPlan";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";

export type McpRunToolRoute = Readonly<{
  fingerprint: string;
  originalName: string;
  serverId: string;
  tool: McpRunPlanTool;
}>;

export function mcpRunTools(snapshot: McpRunPlanSnapshot | undefined): RunTool[] {
  return (snapshot?.tools ?? []).map((tool) => ({
    capability: "mcp",
    description: tool.description ?? tool.title ?? `Tool ${tool.originalName} from ${tool.serverName}`,
    inputSchema: tool.inputSchema,
    name: tool.namespacedName,
    strict: false
  }));
}

export function resolveMcpRunTool(
  snapshot: McpRunPlanSnapshot | undefined,
  namespacedName: string
): McpRunToolRoute | null {
  const tool = snapshot?.tools.find((candidate) => candidate.namespacedName === namespacedName);
  if (!tool) return null;
  const server = snapshot?.servers.find((candidate) => candidate.serverId === tool.serverId);
  if (!server) return null;
  return {
    fingerprint: server.fingerprint,
    originalName: tool.originalName,
    serverId: tool.serverId,
    tool
  };
}

export function mcpToolExecutionResult(
  call: ModelToolCall,
  result: AiqsaMcpToolCallResult
): ToolExecutionResult {
  const content: ToolExecutionResult["content"] = [
    ...result.text.map((text) => ({ text, type: "text" as const })),
    ...(result.structuredContent ? [{ type: "json" as const, value: result.structuredContent }] : [])
  ];
  if (content.length === 0) {
    content.push({
      text: result.isError ? "The MCP tool reported an error." : "The MCP tool completed without text output.",
      type: "text"
    });
  }
  return {
    callId: call.id,
    content,
    name: call.name,
    rawPreview: {
      isError: result.isError,
      unsupportedContentTypes: [...result.unsupportedContentTypes]
    },
    status: result.isError ? "error" : "complete"
  };
}
