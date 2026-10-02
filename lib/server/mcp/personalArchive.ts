import { Prisma } from "@prisma/client";

type PersonalArchiveClient = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "mcpActivationJob" | "mcpOAuthConnection" | "mcpServer" | "mcpUserServer"
>;

/**
 * Disconnects an owner's live personal MCP servers: every stored OAuth token
 * becomes a revocation obligation, the owner's preference loses its runtime,
 * stored values and discovered inventory, and the server keeps no draft
 * evidence. Revisions and runtime generations leave with finalization, which
 * deletes an archived server only after its tokens were revoked or abandoned.
 * Callers hold the owner's lock; the server rows are locked here, in id order,
 * before any of their children change.
 */
export async function archivePersonalMcpServers(
  tx: PersonalArchiveClient,
  input: Readonly<{ now: Date; ownerUserId: string; serverIds?: readonly string[] }>
): Promise<string[]> {
  if (input.serverIds?.length === 0) return [];
  const live = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "McpServer"
    WHERE "ownerUserId" = ${input.ownerUserId}
      AND "archivedAt" IS NULL
      ${input.serverIds ? Prisma.sql`AND "id" IN (${Prisma.join([...input.serverIds])})` : Prisma.empty}
    ORDER BY "id"
    FOR UPDATE
  `;
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
