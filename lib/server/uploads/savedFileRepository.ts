import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import type { SavedFileRepository } from "./savedFileHandlers";

/**
 * Copies immutable attachment identity, never its owning chat/run. Sharing the
 * settled object retains existing per-key reference/deletion accounting.
 */
export function createSavedFileRepository(client: PrismaClient = prisma): SavedFileRepository {
  return {
    async copy({ attachmentId, save, userId }) {
      return client.$transaction(async (tx) => {
        const identity = await tx.attachment.findFirst({
          select: { chatId: true, storageKey: true },
          where: { id: attachmentId, projectId: null, userId }
        });
        if (!identity) return null;

        // Match chat deletion's lock order. A deletion already admitted must
        // never gain a new object reference after its exclusive-object check.
        if (identity.chatId) {
          const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "Chat"
            WHERE "id" = ${identity.chatId} AND "userId" = ${userId}
              AND "projectId" IS NULL AND "permanentDeletionAt" IS NULL
              AND "memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
            FOR SHARE
          `);
          if (rows.length !== 1) return null;
        }
        // The same per-object lock as retention serializes new references
        // with its reference snapshot and also makes repeated saves idempotent.
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${identity.storageKey}, 260))::text
        `);
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "Attachment"
          WHERE "id" = ${attachmentId} AND "userId" = ${userId} AND "projectId" IS NULL
          FOR UPDATE
        `);
        if (locked.length !== 1) return null;
        const source = await tx.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
        if (source.chatId !== identity.chatId || source.storageKey !== identity.storageKey || !source.checksum) return null;
        if (await tx.attachmentDeletionJob.findUnique({
          select: { id: true }, where: { storageKey: source.storageKey }
        })) return null;
        if (save && source.savedAt) return source;
        if (save) {
          const saved = await tx.attachment.findFirst({
            where: { projectId: null, savedAt: { not: null }, storageKey: source.storageKey, userId }
          });
          if (saved) return saved;
        }
        return tx.attachment.create({
          data: {
            byteSize: source.byteSize,
            checksum: source.checksum,
            extractedText: source.extractedText,
            fileName: source.fileName,
            kind: source.kind,
            metadata: source.metadata === null ? Prisma.JsonNull : source.metadata as Prisma.InputJsonValue,
            mimeType: source.mimeType,
            processingErrorCode: source.processingErrorCode,
            ...(source.status === "processing"
              ? { processingJob: { create: { ownerUserId: userId } } }
              : {}),
            savedAt: save ? new Date() : null,
            status: source.status,
            storageKey: source.storageKey,
            userId
          }
        });
      });
    },
    async remove({ attachmentId, userId }) {
      // Release the Library pin. Ordinary retention removes an unreferenced
      // object; copies already used in other chats retain their own lifetime.
      return client.$transaction(async (tx) => {
        const file = await tx.attachment.findFirst({
          select: { storageKey: true },
          where: { id: attachmentId, projectId: null, savedAt: { not: null }, userId }
        });
        if (!file) return false;
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${file.storageKey}, 260))::text
        `);
        const result = await tx.attachment.updateMany({
          data: { savedAt: null },
          where: { id: attachmentId, projectId: null, savedAt: { not: null }, userId }
        });
        return result.count === 1;
      });
    }
  };
}
