import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AttachmentDownloadRecord,
  AttachmentDownloadRepository
} from "./downloadHandlers";

export function createPrismaAttachmentDownloadRepository(
  prisma: PrismaClient
): AttachmentDownloadRepository {
  return {
    async resolve(input): Promise<AttachmentDownloadRecord | null> {
      return prisma.$transaction(async (tx) => {
        const attachment = await tx.attachment.findUnique({
          select: {
            byteSize: true,
            fileName: true,
            id: true,
            mimeType: true,
            storageKey: true,
            userId: true
          },
          where: { id: input.attachmentId, status: "ready" }
        });
        if (!attachment || attachment.userId !== input.userId) return null;
        return {
          byteSize: attachment.byteSize,
          fileName: attachment.fileName,
          id: attachment.id,
          mimeType: attachment.mimeType,
          storageKey: attachment.storageKey
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    }
  };
}
