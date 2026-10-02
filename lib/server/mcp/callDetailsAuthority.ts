import type { Prisma } from "@prisma/client";
import { toolActivityDescriptors } from "../tools/activityDescriptors";
import { assertMcpToolAccess } from "./toolAccess";

export const mcpDetailRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type AcceptedMcpCallIdentity = Readonly<{ serverId: string; originalName: string; revisionId: string; fingerprint: string }>;

/** Presentation's mcp_ fallback is never authority. Exact accepted tool plus
 * its persisted run binding must agree, including Auto-discovered tools. */
export function acceptedMcpCallIdentity(normalizedRequest: unknown, toolName: string,
  fingerprint: string | null | undefined): AcceptedMcpCallIdentity | null {
  if (!mcpDetailRecord(normalizedRequest) || normalizedRequest.agent || !fingerprint ||
    toolActivityDescriptors(normalizedRequest).get(toolName)?.origin !== "mcp") return null;
  const plan = normalizedRequest.mcp;
  if (!mcpDetailRecord(plan) || !Array.isArray(plan.tools) || !Array.isArray(plan.servers)) return null;
  const tool = plan.tools.find(tool => mcpDetailRecord(tool) && tool.namespacedName === toolName);
  if (!mcpDetailRecord(tool) || typeof tool.serverId !== "string" || typeof tool.originalName !== "string") return null;
  const server = plan.servers.find(server => mcpDetailRecord(server) && server.serverId === tool.serverId && server.fingerprint === fingerprint);
  if (!mcpDetailRecord(server) || typeof server.revisionId !== "string") return null;
  return { serverId: tool.serverId, originalName: tool.originalName, revisionId: server.revisionId, fingerprint };
}

/** Both stored-inline and original-observation reads retain current MCP
 * grants/tool restrictions. No discovery, runtime startup or OAuth refresh. */
export async function canReadAcceptedMcpCall(tx: Prisma.TransactionClient, input: AcceptedMcpCallIdentity & {
  projectId: string | null; userId: string;
}): Promise<boolean> {
  const memberships = await tx.userGroup.findMany({ where: { userId: input.userId, group: { archivedAt: null } }, select: { groupId: true } });
  const server = await tx.mcpServer.findFirst({ where: { id: input.serverId, enabled: true, archivedAt: null,
    ...(input.projectId ? { projectBindings: { some: { projectId: input.projectId } }, ownerUserId: null } : {
      OR: [{ ownerUserId: null }, { ownerUserId: input.userId }],
      grants: { some: { canUse: true, OR: [{ userId: input.userId }, { groupId: { in: memberships.map(item => item.groupId) } }] } },
      userServers: { some: { userId: input.userId, enabled: true } }
    }) }, select: { activeRevision: { select: { configuration: true } } } });
  if (!server?.activeRevision) return false;
  const config = server.activeRevision.configuration;
  if (mcpDetailRecord(config) && Array.isArray(config.disabledToolNames) && config.disabledToolNames.includes(input.originalName)) return false;
  try { await assertMcpToolAccess(tx, input.userId, [{ serverId: input.serverId, originalName: input.originalName }]); }
  catch (error) {
    if (error instanceof Error && error.name === "McpToolAccessDeniedError") return false;
    throw error;
  }
  return true;
}
