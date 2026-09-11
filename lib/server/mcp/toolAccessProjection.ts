import type { ProviderRunRequest } from "../providers/types";
import type { McpCapabilityCatalog } from "./runPlan";
import type { McpToolAccessFilter } from "./toolAccess";
import { MCP_FIND_TOOLS_NAME } from "./discovery";

export async function filterMcpCatalog(
  userId: string,
  catalog: McpCapabilityCatalog,
  filterTools: McpToolAccessFilter
): Promise<McpCapabilityCatalog> {
  const tools = await filterTools(userId, catalog.servers.flatMap((server) =>
    server.tools.map((tool) => ({ ...tool, serverId: server.serverId }))));
  const names = new Set(tools.map(({ namespacedName }) => namespacedName));
  return {
    ...catalog,
    servers: catalog.servers.map((server) => ({
      ...server, tools: server.tools.filter(({ namespacedName }) => names.has(namespacedName))
    })).filter((server) => server.tools.length > 0)
  };
}

/** Current exposure only. Accepted definitions, epochs and settled results stay intact. */
export async function filterMcpProviderRequest(
  request: ProviderRunRequest,
  userId: string,
  filterTools: McpToolAccessFilter
): Promise<ProviderRunRequest> {
  const snapshotTools = request.mcp?.tools ?? [];
  const catalogTools = request.mcpDiscovery?.catalog.servers.flatMap((server) =>
    server.tools.map((tool) => ({ ...tool, serverId: server.serverId }))) ?? [];
  const allowed = await filterTools(userId, [...snapshotTools, ...catalogTools]);
  const names = new Set(allowed.map(({ namespacedName }) => namespacedName));
  return {
    ...request,
    ...(request.tools ? { tools: request.tools.filter((tool) =>
      tool.capability !== "mcp" || names.has(tool.name) ||
      (tool.name === MCP_FIND_TOOLS_NAME && request.mcpDiscovery !== undefined)) } : {}),
    ...(request.mcp ? { mcp: {
      ...request.mcp, tools: snapshotTools.filter(({ namespacedName }) => names.has(namespacedName))
    } } : {}),
    ...(request.mcpDiscovery ? { mcpDiscovery: {
      ...request.mcpDiscovery,
      catalog: {
        ...request.mcpDiscovery.catalog,
        servers: request.mcpDiscovery.catalog.servers.map((server) => ({
          ...server, tools: server.tools.filter(({ namespacedName }) => names.has(namespacedName))
        })).filter((server) => server.tools.length > 0)
      }
    } } : {})
  };
}
