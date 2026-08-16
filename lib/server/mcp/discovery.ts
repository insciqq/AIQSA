import type { ModelToolCall, RunTool, ToolExecutionResult } from "../tools/types";
import { MCP_RUN_PLAN_LIMITS } from "../../contracts/mcp";
import type {
  McpCapabilityCatalog,
  McpCapabilityCatalogServer,
  McpCapabilityCatalogTool,
  McpRunPlanSnapshot
} from "./runPlan";

export const MCP_FIND_TOOLS_NAME = "find_tools";
export const MCP_DISCOVERY_MAX_RESULTS = 5;
export const MCP_DISCOVERY_MAX_ACTIVE_TOOLS = 12;

export const mcpFindToolsTool: RunTool = {
  capability: "mcp",
  description:
    "Search the user's enabled MCP integrations for tools relevant to the current task. " +
    "Call this before attempting an MCP action; matching tools become available on the next step.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      limit: {
        maximum: MCP_DISCOVERY_MAX_RESULTS,
        minimum: 1,
        type: "integer"
      },
      query: {
        description: "A concise capability or task, such as 'create a GitHub issue'.",
        maxLength: 400,
        minLength: 1,
        type: "string"
      }
    },
    required: ["query"],
    type: "object"
  },
  name: MCP_FIND_TOOLS_NAME,
  strict: false
};

export type RankedMcpCatalogTool = {
  description: string | null;
  namespacedName: string;
  originalName: string;
  revisionId: string;
  score: number;
  serverDescription: string;
  serverId: string;
  serverName: string;
  title?: string;
};

export function mcpCatalogToolsByNames(
  catalog: McpCapabilityCatalog,
  namespacedNames: readonly string[]
): RankedMcpCatalogTool[] {
  const tools = new Map(catalog.servers.flatMap((server) =>
    server.tools.map((tool) => [tool.namespacedName, {
      description: tool.description,
      namespacedName: tool.namespacedName,
      originalName: tool.originalName,
      revisionId: server.revisionId,
      score: 0,
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

function normalize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value: string): string[] {
  return [...new Set(normalize(value).split(/\s+/u).filter((token) => token.length > 1))];
}

function scoreTool(
  query: string,
  queryTokens: readonly string[],
  server: McpCapabilityCatalogServer,
  tool: McpCapabilityCatalogTool
): number {
  const normalizedQuery = normalize(query);
  const name = normalize(tool.originalName);
  const title = normalize(tool.title ?? "");
  const serverName = normalize(server.serverName);
  const description = normalize(tool.description ?? "");
  const serverDescription = normalize(server.description);
  let score = 0;
  if (name === normalizedQuery || title === normalizedQuery) score += 120;
  if (name.includes(normalizedQuery) || title.includes(normalizedQuery)) score += 40;
  for (const token of queryTokens) {
    if (name.split(" ").includes(token)) score += 24;
    else if (name.includes(token)) score += 14;
    if (title.split(" ").includes(token)) score += 18;
    else if (title.includes(token)) score += 10;
    if (serverName.split(" ").includes(token)) score += 12;
    else if (serverName.includes(token)) score += 7;
    if (description.includes(token)) score += 4;
    if (serverDescription.includes(token)) score += 2;
  }
  return score;
}

export function rankMcpCatalogTools(input: {
  activeToolNames?: ReadonlySet<string>;
  catalog: McpCapabilityCatalog;
  limit?: number;
  query: string;
}): RankedMcpCatalogTool[] {
  const query = input.query.trim().slice(0, 400);
  const queryTokens = tokens(query);
  if (!query || queryTokens.length === 0) return [];
  const limit = Math.min(
    MCP_DISCOVERY_MAX_RESULTS,
    Math.max(1, Number.isInteger(input.limit) ? Number(input.limit) : MCP_DISCOVERY_MAX_RESULTS)
  );
  const ranked = input.catalog.servers.flatMap((server) =>
    server.tools.flatMap((tool) => {
      if (input.activeToolNames?.has(tool.namespacedName)) return [];
      const score = scoreTool(query, queryTokens, server, tool);
      return score > 0
        ? [{
            description: tool.description,
            namespacedName: tool.namespacedName,
            originalName: tool.originalName,
            revisionId: server.revisionId,
            score,
            serverDescription: server.description,
            serverId: server.serverId,
            serverName: server.serverName,
            ...(tool.title ? { title: tool.title } : {})
          }]
        : [];
    })
  );
  return ranked
    .sort((left, right) =>
      right.score - left.score ||
      left.serverName.localeCompare(right.serverName) ||
      left.namespacedName.localeCompare(right.namespacedName)
    )
    .slice(0, limit);
}

export function mcpFindToolsArguments(argumentsValue: Record<string, unknown>): {
  limit: number;
  query: string;
} | null {
  if (Object.keys(argumentsValue).some((key) => key !== "limit" && key !== "query")) {
    return null;
  }
  const query = typeof argumentsValue.query === "string" ? argumentsValue.query.trim() : "";
  if (!query || query.length > 400) return null;
  const limit = argumentsValue.limit === undefined
    ? MCP_DISCOVERY_MAX_RESULTS
    : argumentsValue.limit;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > MCP_DISCOVERY_MAX_RESULTS) {
    return null;
  }
  return { limit: Number(limit), query };
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
  if (tools.size > MCP_DISCOVERY_MAX_ACTIVE_TOOLS) {
    throw new Error("mcp_discovery_tool_limit");
  }
  const mergedTools = [...tools.values()];
  const schemaBytes = mergedTools.reduce((total, tool) => total + Buffer.byteLength(
    JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }),
    "utf8"
  ), 0);
  if (schemaBytes > MCP_RUN_PLAN_LIMITS.maxToolSchemaBytes) {
    throw new Error("mcp_discovery_schema_limit");
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
  tools: readonly RankedMcpCatalogTool[]
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
