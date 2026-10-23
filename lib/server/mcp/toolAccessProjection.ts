import type { McpCapabilityCatalog } from "./runPlan";
import type { McpToolAccessFilter } from "./toolAccess";

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
