import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import type {
  AttachmentLibraryRecord,
  AttachmentLibraryRepository
} from "./libraryHandlers";

/**
 * Library navigation is only truthful for attachments whose source message is
 * on the chat's current active path. The recursive query applies that same DAG
 * projection before the global recency limit, and keeps Temporary chats out of
 * the durable personal library entirely.
 */
export function createPrismaAttachmentLibraryRepository(
  prismaClient: PrismaClient = prisma
): AttachmentLibraryRepository {
  return {
    async listSent({ limit, userId }) {
      return prismaClient.$queryRaw<AttachmentLibraryRecord[]>(Prisma.sql`
        WITH RECURSIVE "active_messages" AS (
          SELECT
            message."id",
            message."chatId",
            message."parentMessageId"
          FROM "Chat" AS chat
          INNER JOIN "Message" AS message
            ON message."chatId" = chat."id"
            AND message."id" = chat."activeLeafMessageId"
          WHERE chat."userId" = ${userId}
            AND chat."projectId" IS NULL
            AND chat."archived" = false
            AND chat."permanentDeletionAt" IS NULL
            AND chat."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"

          UNION ALL

          SELECT
            parent."id",
            parent."chatId",
            parent."parentMessageId"
          FROM "active_messages" AS child
          INNER JOIN "Message" AS parent
            ON parent."chatId" = child."chatId"
            AND parent."id" = child."parentMessageId"
        )
        SELECT
          attachment."byteSize",
          attachment."createdAt",
          attachment."fileName",
          attachment."id",
          attachment."messageId",
          attachment."status",
          chat."id" AS "chatId",
          chat."title" AS "chatTitle"
        FROM "Attachment" AS attachment
        INNER JOIN "active_messages" AS active_message
          ON active_message."id" = attachment."messageId"
          AND active_message."chatId" = attachment."chatId"
        INNER JOIN "Chat" AS chat
          ON chat."id" = attachment."chatId"
        WHERE attachment."userId" = ${userId}
          AND attachment."projectId" IS NULL
        ORDER BY attachment."createdAt" DESC, attachment."id" DESC
        LIMIT ${limit}
      `);
    }
  };
}

export const attachmentLibraryRepository = createPrismaAttachmentLibraryRepository();
