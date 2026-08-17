import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import type {
  McpCapabilityCatalog,
  McpRunPlanSnapshot
} from "./runPlan";

export const MCP_FIND_TOOLS_NAME = "find_tools";
export const LEGACY_MCP_DISCOVERY_MAX_RESULTS = 5;

export const mcpFindToolsTool: RunTool = {
  capability: "mcp",
  description:
    "Find enabled MCP tools that can help accomplish the user's goal. Describe the intended outcome, " +
    "service, and action in the user's natural language; spelling corrections are unnecessary. " +
    "The server performs multilingual semantic routing and loads matching tools for the next step. " +
    "This call itself has no external side effects.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      goal: {
        description: "The outcome that needs an MCP capability, such as 'create a GitHub issue'.",
        maxLength: 400,
        minLength: 1,
        type: "string"
      }
    },
    required: ["goal"],
    type: "object"
  },
  name: MCP_FIND_TOOLS_NAME,
  strict: false
};

export type McpCatalogToolSelection = {
  description: string | null;
  namespacedName: string;
  originalName: string;
  revisionId: string;
  serverDescription: string;
  serverId: string;
  serverName: string;
  title?: string;
};

export function mcpCatalogToolsByNames(
  catalog: McpCapabilityCatalog,
  namespacedNames: readonly string[]
): McpCatalogToolSelection[] {
  const tools = new Map(catalog.servers.flatMap((server) =>
    server.tools.map((tool) => [tool.namespacedName, {
      description: tool.description,
      namespacedName: tool.namespacedName,
      originalName: tool.originalName,
      revisionId: server.revisionId,
      serverDescription: server.description,
      serverId: server.serverId,
      serverName: server.serverName,
      ...(tool.title ? { title: tool.title } : {})
    }] as const)
  ));
  return namespacedNames.flatMap((name) => {
    const tool = tools.get(name);
    return tool ? [tool] : [];
  });
}

export function mcpFindToolsArguments(argumentsValue: Record<string, unknown>): {
  goal: string;
} | null {
  if (Object.keys(argumentsValue).some((key) => key !== "goal")) {
    return null;
  }
  const goal = typeof argumentsValue.goal === "string" ? argumentsValue.goal.trim() : "";
  return !goal || goal.length > 400 ? null : { goal };
}

export function mergeMcpRunPlanSnapshots(
  current: McpRunPlanSnapshot | undefined,
  added: McpRunPlanSnapshot
): McpRunPlanSnapshot {
  const servers = new Map(
    (current?.servers ?? []).map((server) => [server.serverId, server] as const)
  );
  for (const server of added.servers) {
    const existing = servers.get(server.serverId);
    if (existing && (
      existing.fingerprint !== server.fingerprint || existing.revisionId !== server.revisionId
    )) {
      throw new Error("mcp_discovery_binding_changed");
    }
    servers.set(server.serverId, server);
  }
  const tools = new Map(
    (current?.tools ?? []).map((tool) => [tool.namespacedName, tool] as const)
  );
  for (const tool of added.tools) {
    const existing = tools.get(tool.namespacedName);
    if (existing && existing.definitionHash !== tool.definitionHash) {
      throw new Error("mcp_discovery_tool_changed");
    }
    tools.set(tool.namespacedName, tool);
  }
  const mergedTools = [...tools.values()];
  const schemaBytes = mergedTools.reduce((total, tool) => total + Buffer.byteLength(
    JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }),
    "utf8"
  ), 0);
  if (mergedTools.length > MCP_RUN_PLAN_LIMITS.maxTools ||
    schemaBytes > MCP_RUN_PLAN_LIMITS.maxToolSchemaBytes) {
    throw new Error("mcp_plan_too_large");
  }
  return {
    servers: [...servers.values()].sort((left, right) =>
      left.serverName.localeCompare(right.serverName) || left.serverId.localeCompare(right.serverId)
    ),
    tools: mergedTools,
    version: 1
  };
}

export function mcpFindToolsExecutionResult(
  call: ModelToolCall,
  tools: readonly McpCatalogToolSelection[]
): ToolExecutionResult {
  const text = tools.length === 0
    ? "No matching enabled MCP tools were found. Try a more specific capability or service name."
    : [
        `Loaded ${tools.length} MCP ${tools.length === 1 ? "tool" : "tools"} for this run:`,
        ...tools.map((tool) =>
          `- ${tool.namespacedName}: ${tool.description ?? tool.title ?? `${tool.originalName} from ${tool.serverName}`}`
        ),
        "These tools are available on the next step."
      ].join("\n");
  return {
    callId: call.id,
    content: [{ text, type: "text" }],
    name: call.name,
    status: "complete"
  };
}
