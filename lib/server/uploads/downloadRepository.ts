import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveProjectAccess } from "@/lib/server/projects/access";
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
            projectId: true,
            storageKey: true,
            userId: true
          },
          where: { id: input.attachmentId }
        });
        if (!attachment) return null;
        if (attachment.userId !== null) {
          if (attachment.userId !== input.userId || attachment.projectId !== null) return null;
        } else {
          if (!attachment.projectId) return null;
          const access = await resolveProjectAccess(tx, {
            projectId: attachment.projectId,
            userId: input.userId
          });
          if (!access) return null;
        }
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
