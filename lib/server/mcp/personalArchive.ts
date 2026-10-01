import { Prisma } from "@prisma/client";

type PersonalArchiveClient = Pick<
  Prisma.TransactionClient,
  "mcpActivationJob" | "mcpOAuthConnection" | "mcpServer" | "mcpUserServer"
>;

/**
 * Disconnects an owner's live personal MCP servers: every stored OAuth token
 * becomes a revocation obligation, the owner's preference loses its runtime,
 * stored values and discovered inventory, and the server keeps no draft
 * evidence. Revisions and runtime generations leave with finalization, which
 * deletes an archived server only after its tokens were revoked or abandoned.
 */
export async function archivePersonalMcpServers(
  tx: PersonalArchiveClient,
  input: Readonly<{ now: Date; ownerUserId: string; serverIds?: readonly string[] }>
): Promise<string[]> {
  const live = await tx.mcpServer.findMany({
    select: { id: true },
    where: {
      archivedAt: null,
      ownerUserId: input.ownerUserId,
      ...(input.serverIds ? { id: { in: [...input.serverIds] } } : {})
    }
  });
  const serverIds = live.map(({ id }) => id);
  if (!serverIds.length) return [];
  await tx.mcpOAuthConnection.updateMany({
    data: { disconnectRequestedAt: input.now, state: "disconnecting" },
    where: { serverId: { in: serverIds }, state: { in: ["ready", "reauthorization_required"] } }
  });
  await tx.mcpUserServer.updateMany({
    data: {
      desiredRuntimeGenerationId: null,
      discoveredInventory: Prisma.DbNull,
      discoveredOAuthConnectionId: null,
      discoveredRevisionId: null,
      enabled: false,
      personalConfigEnvelope: null
    },
    where: { serverId: { in: serverIds } }
  });
  await tx.mcpServer.updateMany({
    data: { archivedAt: input.now, draftTestEvidence: Prisma.DbNull, enabled: false },
    where: { archivedAt: null, id: { in: serverIds }, ownerUserId: input.ownerUserId }
  });
  await tx.mcpActivationJob.deleteMany({ where: { serverId: { in: serverIds } } });
  return serverIds;
}
