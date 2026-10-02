import type { Prisma } from "@prisma/client";

/**
 * Rows left by the removed local (npm, PyPI, OCI) MCP sources. A local server
 * runs a local active revision, or has no active revision and a local draft. A
 * local draft on any other server sits on a remote active revision. Local
 * revisions may also remain in the history of a server that is not local.
 */
export type LocalMcpLeftovers = Readonly<{
  localDraftServerIds: readonly string[];
  localServerIds: readonly string[];
  otherLocalRevisionIds: readonly string[];
}>;

export type LocalMcpRemovalResult = Readonly<{ removedCount: number }>;

type InspectionRow = {
  localDraftServerIds: string[] | null;
  localServerIds: string[] | null;
  otherLocalRevisionIds: string[] | null;
};

export function localMcpLeftoverCount(leftovers: LocalMcpLeftovers): number {
  return leftovers.localServerIds.length + leftovers.localDraftServerIds.length +
    leftovers.otherLocalRevisionIds.length;
}

export async function inspectLocalMcpLeftovers(tx: Prisma.TransactionClient): Promise<LocalMcpLeftovers> {
  const rows = await tx.$queryRaw<InspectionRow[]>`
    WITH server_state AS (
      SELECT server_row."id",
        COALESCE(CASE WHEN active."id" IS NULL
          THEN server_row."draft"->'source'->>'kind'
          ELSE active."configuration"->'source'->>'kind'
        END IN ('npm', 'pypi', 'oci'), false) AS "local",
        COALESCE(server_row."draft"->'source'->>'kind' IN ('npm', 'pypi', 'oci'), false) AS "localDraft"
      FROM "McpServer" AS server_row
      LEFT JOIN "McpRevision" AS active ON active."id" = server_row."activeRevisionId"
    )
    SELECT
      ARRAY(SELECT "id" FROM server_state WHERE "local" ORDER BY "id") AS "localServerIds",
      ARRAY(SELECT "id" FROM server_state WHERE "localDraft" AND NOT "local" ORDER BY "id") AS "localDraftServerIds",
      ARRAY(
        SELECT revision."id"
        FROM "McpRevision" AS revision
        JOIN server_state ON server_state."id" = revision."serverId"
        WHERE NOT server_state."local"
          AND revision."configuration"->'source'->>'kind' IN ('npm', 'pypi', 'oci')
        ORDER BY revision."id"
      ) AS "otherLocalRevisionIds"
  `;
  const row = rows[0];
  if (!row) throw new Error("local_mcp_inspection_empty");

  return {
    localDraftServerIds: row.localDraftServerIds ?? [],
    localServerIds: row.localServerIds ?? [],
    otherLocalRevisionIds: row.otherLocalRevisionIds ?? []
  };
}

/**
 * Deletes exactly the inspected leftovers in foreign-key order. `McpRevision`
 * and `McpRuntimeGeneration` parents are `Restrict`, so children go first.
 * Run bindings keep their fingerprint; their generation reference becomes NULL.
 */
export async function removeLocalMcpLeftovers(
  tx: Prisma.TransactionClient,
  leftovers: LocalMcpLeftovers
): Promise<void> {
  const localServerIds = [...leftovers.localServerIds];
  const draftServerIds = [...leftovers.localDraftServerIds];
  const otherRevisionIds = [...leftovers.otherLocalRevisionIds];
  // OAuth clients shared with no other connection go with the servers, as in
  // ordinary finalization; connections cascade, so collect the clients first.
  const oauthConnections = localServerIds.length > 0
    ? await tx.mcpOAuthConnection.findMany({
      select: { oauthClientId: true },
      where: { oauthClientId: { not: null }, serverId: { in: localServerIds } }
    })
    : [];
  const oauthClientIds = [...new Set(oauthConnections.flatMap((connection) =>
    connection.oauthClientId ? [connection.oauthClientId] : []
  ))];

  await tx.projectMcpBinding.deleteMany({ where: { serverId: { in: localServerIds } } });
  // Every generation that would block a revision or OAuth connection removal.
  await tx.mcpRuntimeGeneration.deleteMany({
    where: {
      OR: [
        { revision: { serverId: { in: localServerIds } } },
        { revisionId: { in: otherRevisionIds } },
        { userServer: { serverId: { in: localServerIds } } },
        { sharedServerId: { in: localServerIds } },
        { oauthConnection: { serverId: { in: localServerIds } } }
      ]
    }
  });
  // Active and discovered revision references are ON DELETE SET NULL.
  await tx.mcpRevision.deleteMany({
    where: { OR: [{ serverId: { in: localServerIds } }, { id: { in: otherRevisionIds } }] }
  });
  if (draftServerIds.length > 0) {
    // The draft returns to the active configuration, as a rebuild of it does.
    await tx.$executeRaw`
      UPDATE "McpServer" AS server_row
      SET "draft" = active."configuration",
        "testedDraftHash" = NULL,
        "draftTestEvidence" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM "McpRevision" AS active
      WHERE active."id" = server_row."activeRevisionId"
        AND server_row."id" = ANY(${draftServerIds}::text[])
    `;
    await tx.mcpActivationJob.deleteMany({ where: { serverId: { in: draftServerIds } } });
  }
  // Cascades activation jobs, grants, tool policies, OAuth connections,
  // member preferences and the shared Project runtime.
  await tx.mcpServer.deleteMany({ where: { id: { in: localServerIds } } });
  if (oauthClientIds.length > 0) {
    await tx.mcpOAuthClient.deleteMany({ where: { connections: { none: {} }, id: { in: oauthClientIds } } });
  }
}

/**
 * Bootstrap gate for leftover local MCP rows. Nothing left: no change and the
 * acknowledgement is ignored. Without the acknowledgement the caller's
 * transaction rolls back through `refuse`; with it the rows are deleted.
 */
export async function applyLocalMcpRemovalGate(
  tx: Prisma.TransactionClient,
  input: Readonly<{ acknowledged: boolean; refuse: (count: number) => Error }>
): Promise<LocalMcpRemovalResult> {
  const leftovers = await inspectLocalMcpLeftovers(tx);
  const count = localMcpLeftoverCount(leftovers);

  if (count === 0) return { removedCount: 0 };
  if (!input.acknowledged) throw input.refuse(count);

  await removeLocalMcpLeftovers(tx, leftovers);
  return { removedCount: count };
}
