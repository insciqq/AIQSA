import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";

export type McpToolIdentity = Readonly<{ serverId: string; originalName: string }>;

export type McpToolAccessFilter = <T extends McpToolIdentity>(
  userId: string,
  tools: readonly T[]
) => Promise<T[]>;

export class McpToolAccessDeniedError extends Error {
  readonly code = "mcp_tool_access_denied";
  constructor() {
    super("You no longer have access to this MCP tool.");
    this.name = "McpToolAccessDeniedError";
  }
}

type ToolAccessClient = Pick<Prisma.TransactionClient, "user" | "mcpToolAccessPolicy">;
type ToolPolicy = {
  serverId: string;
  toolName: string;
  restricted: boolean;
  users: { userId: string }[];
  groups: { groupId: string }[];
};

/** Additional tool permission only; callers retain their existing MCP authority. */
export function resolveMcpToolAccess(
  actor: { id: string; active: boolean; groupIds: readonly string[] },
  policies: readonly ToolPolicy[]
): (tool: McpToolIdentity) => boolean {
  const groups = new Set(actor.groupIds);
  const denied = new Set(policies.filter((policy) => policy.restricted &&
    !policy.users.some(({ userId }) => userId === actor.id) &&
    !policy.groups.some(({ groupId }) => groups.has(groupId))
  ).map((policy) => JSON.stringify([policy.serverId, policy.toolName])));
  return (tool) => actor.active && !denied.has(JSON.stringify([tool.serverId, tool.originalName]));
}

export async function loadMcpToolAccess(
  userId: string,
  serverIds: readonly string[],
  client: ToolAccessClient = prisma
): Promise<(tool: McpToolIdentity) => boolean> {
  const [user, policies] = await Promise.all([
    client.user.findUnique({
      select: {
        status: true,
        groups: { select: { groupId: true }, where: { group: { archivedAt: null } } }
      },
      where: { id: userId }
    }),
    client.mcpToolAccessPolicy.findMany({
      select: {
        serverId: true, toolName: true, restricted: true,
        users: { select: { userId: true } }, groups: { select: { groupId: true } }
      },
      where: { serverId: { in: [...new Set(serverIds)] }, restricted: true }
    })
  ]);
  return resolveMcpToolAccess({
    id: userId, active: user?.status === "active",
    groupIds: user?.groups.map(({ groupId }) => groupId) ?? []
  }, policies);
}

export async function filterMcpToolsForUser<T extends McpToolIdentity>(
  userId: string,
  tools: readonly T[],
  client: ToolAccessClient = prisma
): Promise<T[]> {
  if (!tools.length) return [];
  const allowed = await loadMcpToolAccess(userId, tools.map(({ serverId }) => serverId), client);
  return tools.filter(allowed);
}

/** A Hub grant covers installation MCPs only, never a user's own connections. */
export async function filterMcpToolsForHub<T extends McpToolIdentity>(
  userId: string,
  tools: readonly T[],
  client: ToolAccessClient & Pick<Prisma.TransactionClient, "mcpServer"> = prisma
): Promise<T[]> {
  if (!tools.length) return [];
  const servers = await client.mcpServer.findMany({
    select: { id: true },
    where: { archivedAt: null, enabled: true, id: { in: [...new Set(tools.map(({ serverId }) => serverId))] }, ownerUserId: null }
  });
  const ids = new Set(servers.map(({ id }) => id));
  return filterMcpToolsForUser(userId, tools.filter(({ serverId }) => ids.has(serverId)), client);
}

export async function assertMcpToolAccess(
  client: ToolAccessClient,
  userId: string,
  tools: readonly McpToolIdentity[]
): Promise<void> {
  if ((await filterMcpToolsForUser(userId, tools, client)).length !== tools.length) {
    throw new McpToolAccessDeniedError();
  }
}
