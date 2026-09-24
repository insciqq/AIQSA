import { Prisma, type PrismaClient } from "@prisma/client";
import { WORKSPACE_EXPORT_PAGE_SIZE, type WorkspaceExportEntry } from "../../contracts/workspaceExports";
import { prisma } from "../prisma";
import { resolveProjectAccess } from "../projects/access";
import type { WorkspaceExportHistoryRepository } from "./exportHistoryHandlers";

export function createWorkspaceExportHistoryRepository(client: PrismaClient = prisma): WorkspaceExportHistoryRepository {
  return {
    async list({ chatId, cursor, userId }) {
      return client.$transaction(async (tx) => {
        const chat = await tx.chat.findFirst({
          select: { activeLeafMessageId: true, projectId: true, userId: true },
          where: { id: chatId, permanentDeletionAt: null }
        });
        if (!chat) return null;
        if (chat.projectId) {
          if (!(await resolveProjectAccess(tx, { projectId: chat.projectId, userId }))) return null;
        } else if (chat.userId !== userId) return null;
        const rows = await tx.$queryRaw<Array<Omit<WorkspaceExportEntry, "createdAt"> & { createdAt: Date }>>(Prisma.sql`
          WITH RECURSIVE path AS (
            SELECT "id", "parentMessageId", "createdAt" FROM "Message"
            WHERE "chatId" = ${chatId} AND "id" = ${chat.activeLeafMessageId}
            UNION ALL
            SELECT parent."id", parent."parentMessageId", parent."createdAt"
            FROM path child INNER JOIN "Message" parent ON parent."id" = child."parentMessageId"
            WHERE parent."chatId" = ${chatId}
          ), visible_outputs AS (
            SELECT o."workspaceRunBindingId" AS "runId", o."attachmentId", o."relativePath", NULL::jsonb AS checkpoint
            FROM "WorkspaceRunOutput" o JOIN "WorkspaceRunBinding" b ON b."modelRunId" = o."workspaceRunBindingId" AND b."exportState" = 'COMPLETE'
            UNION ALL
            SELECT c."modelRunId", f."attachmentId", f."relativePath", jsonb_build_object('id', c."id", 'description', c."description",
              'createdAt', to_char(c."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            FROM "WorkspaceCheckpointFile" f JOIN "WorkspaceOutputCheckpoint" c ON c."id" = f."checkpointId" AND c."state" = 'SETTLED'
          )
          SELECT path."id" AS "messageId", path."createdAt",
            jsonb_agg(jsonb_build_object(
              'attachmentId', attachment."id", 'byteSize', attachment."byteSize",
              'fileName', attachment."fileName", 'mimeType', attachment."mimeType",
              'relativePath', output."relativePath"
            ) || CASE WHEN output.checkpoint IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('checkpoint', output.checkpoint) END ORDER BY output."relativePath", attachment."id") AS files
          FROM path
          INNER JOIN "ModelRun" run ON run."assistantMessageId" = path."id" AND run."chatId" = ${chatId}
          INNER JOIN visible_outputs output ON output."runId" = run."id"
          INNER JOIN "Attachment" attachment ON attachment."id" = output."attachmentId"
            AND attachment."chatId" = ${chatId} AND attachment."messageId" = path."id" AND attachment."status" = 'ready'
          WHERE ${cursor === null ? Prisma.sql`true` : Prisma.sql`
            (path."createdAt", path."id") < (SELECT "createdAt", "id" FROM path WHERE "id" = ${cursor})
          `}
          GROUP BY path."id", path."createdAt"
          ORDER BY path."createdAt" DESC, path."id" DESC
          LIMIT ${WORKSPACE_EXPORT_PAGE_SIZE + 1}
        `);
        const page = rows.slice(0, WORKSPACE_EXPORT_PAGE_SIZE);
        return {
          exports: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
          nextCursor: rows.length > WORKSPACE_EXPORT_PAGE_SIZE ? page.at(-1)!.messageId : null
        };
      });
    }
  };
}
