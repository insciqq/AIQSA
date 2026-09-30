import { Prisma } from "@prisma/client";

/** Callers establish current chat authority; this is the common inbox rule. */
export function workspaceInboxAttachmentWhere(input: Readonly<{
  chatId: string; userId: string; projectId?: string | null;
  ancestorMessageIds: readonly string[]; imageIds: readonly string[]; runId?: string;
}>): Prisma.AttachmentWhereInput {
  return {
    chatId: input.chatId,
    checksum: { not: null, notIn: [""] },
    messageId: { not: null, notIn: [""] },
    kind: { in: ["document", "file", "image", "pdf"] },
    OR: [
      { origin: "USER_UPLOAD" },
      { origin: "WORKSPACE_OUTPUT", status: "ready", messageId: { in: [...input.ancestorMessageIds] }, OR: [
        { producerModelRun: { workspaceRunBinding: { exportState: "COMPLETE" } }, workspaceRunOutput: { isNot: null } },
        { workspaceCheckpointFile: { checkpoint: { state: "SETTLED" } } }
      ] },
      { origin: "IMAGE_OUTPUT", status: "ready", savedAt: null, OR: [
        { id: { in: [...input.imageIds] } }, ...(input.runId ? [{ producerModelRunId: input.runId }] : [])
      ] }
    ],
    ...(input.projectId ? { projectId: input.projectId } : { projectId: null, userId: input.userId })
  };
}

export async function workspaceAncestorMessageIds(client: Pick<Prisma.TransactionClient, "$queryRaw">, chatId: string, leafMessageId: string | null): Promise<string[]> {
  if (!leafMessageId) return [];
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE path AS (
      SELECT "id", "parentMessageId", ARRAY["id"]::text[] AS visited
      FROM "Message" WHERE "chatId" = ${chatId} AND "id" = ${leafMessageId}
      UNION ALL
      SELECT parent."id", parent."parentMessageId", child.visited || parent."id"
      FROM path child INNER JOIN "Message" parent ON parent."id" = child."parentMessageId"
      WHERE parent."chatId" = ${chatId} AND NOT parent."id" = ANY(child.visited)
    ) SELECT "id" FROM path
  `);
  return rows.map(row => row.id);
}
