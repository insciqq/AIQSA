import { validateMcpToolArguments, type AiqsaMcpToolCallResult } from "./clientSession";
import type { McpRunPlanSnapshot, McpRunPlanTool } from "./runPlan";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";

export type McpRunToolRoute = Readonly<{
  fingerprint: string;
  originalName: string;
  serverId: string;
  tool: McpRunPlanTool;
}>;

export type McpToolRuntimeCall = (input: Readonly<{
  arguments: Record<string, unknown>;
  beforeDispatch(): Promise<void>;
  generationId: string;
  inputSchema: Record<string, unknown>;
  name: string;
  signal?: AbortSignal;
}>) => Promise<AiqsaMcpToolCallResult>;

/** The adapters retain their receipts; this boundary owns one authorized call. */
export async function dispatchMcpTool(input: Readonly<{
  arguments: Record<string, unknown>;
  assertCurrent(): Promise<void>;
  callTool: McpToolRuntimeCall;
  generationId: string;
  onDispatch?(): void;
  route: McpRunToolRoute;
  signal?: AbortSignal;
}>): Promise<AiqsaMcpToolCallResult> {
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await input.assertCurrent();
    input.signal?.throwIfAborted();
  };
  await assertCurrent();
  validateMcpToolArguments(input.route.tool.inputSchema, input.arguments);
  let dispatched = false;
  return input.callTool({
    arguments: input.arguments,
    async beforeDispatch() {
      if (dispatched) throw new Error("mcp_call_already_dispatched");
      dispatched = true;
      await assertCurrent();
      input.onDispatch?.();
    },
    generationId: input.generationId,
    inputSchema: input.route.tool.inputSchema,
    name: input.route.originalName,
    signal: input.signal
  });
}

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
