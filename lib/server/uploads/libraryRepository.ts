import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { hiddenActivePathMessageIds } from "../chats/legacyAnswerReviews";
import type {
  AttachmentLibraryRecord,
  AttachmentLibraryRepository
} from "./libraryHandlers";

/**
 * Library navigation is only truthful for attachments whose source message is
 * on the chat's current active path. The recursive query applies that same DAG
 * projection before the global recency limit. Explicitly saved independent
 * copies remain available without a source chat. Temporary chats never enter
 * this durable personal catalog. A step of an answer review recorded before
 * the feature's removal is on no active path as its reader sees it.
 */
export function createPrismaAttachmentLibraryRepository(
  prismaClient: PrismaClient = prisma
): AttachmentLibraryRepository {
  return {
    async listSent({ cursor = null, limit, userId }) {
      const before = cursor ? await prismaClient.attachment.findFirst({
        select: { createdAt: true, id: true, savedAt: true },
        where: { id: cursor, userId }
      }) : null;
      if (cursor && !before) return [];
      const hidden = await hiddenActivePathMessageIds(prismaClient, userId);
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
          attachment."mimeType",
          attachment."savedAt",
          attachment."status",
          chat."id" AS "chatId",
          chat."title" AS "chatTitle"
        FROM "Attachment" AS attachment
        LEFT JOIN "active_messages" AS active_message
          ON active_message."id" = attachment."messageId"
          AND active_message."chatId" = attachment."chatId"
        LEFT JOIN "Chat" AS chat
          ON chat."id" = attachment."chatId"
        WHERE attachment."userId" = ${userId}
          AND (attachment."savedAt" IS NOT NULL OR active_message."id" IS NOT NULL${hidden.length > 0
            ? Prisma.sql` AND NOT (active_message."id" = ANY(${hidden}::text[]))` : Prisma.empty})
          ${before ? Prisma.sql`AND (
            (attachment."savedAt" IS NOT NULL)::int, COALESCE(attachment."savedAt", attachment."createdAt"), attachment."id"
          ) < (${before.savedAt ? 1 : 0}, ${before.savedAt ?? before.createdAt}, ${before.id})` : Prisma.empty}
        ORDER BY (attachment."savedAt" IS NOT NULL) DESC,
          COALESCE(attachment."savedAt", attachment."createdAt") DESC, attachment."id" DESC
        LIMIT ${limit}
      `);
    }
  };
}

export const attachmentLibraryRepository = createPrismaAttachmentLibraryRepository();
