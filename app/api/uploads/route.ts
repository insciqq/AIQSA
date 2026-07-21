import { createUploadHandler } from "@/lib/server/uploads/handlers";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

export const POST = createUploadHandler({
  createAttachment: async (input) => {
    const attachment = await prisma.attachment.create({
      data: {
        byteSize: input.byteSize,
        checksum: input.checksum,
        extractedText: input.extractedText,
        fileName: input.fileName,
        kind: input.kind,
        metadata: input.metadata as Prisma.InputJsonValue,
        mimeType: input.mimeType,
        status: input.status,
        storageKey: input.storageKey,
        userId: input.userId
      }
    });

    return {
      byteSize: attachment.byteSize,
      checksum: attachment.checksum ?? input.checksum,
      extractedText: attachment.extractedText,
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind as "document" | "image" | "pdf",
      metadata: attachment.metadata,
      mimeType: attachment.mimeType,
      status: attachment.status,
      storageKey: attachment.storageKey
    };
  },
  deletionOutbox: {
    async complete(jobId) {
      await prisma.attachmentDeletionJob.deleteMany({
        where: {
          id: jobId
        }
      });
    },
    stage(storageKey) {
      return prisma.attachmentDeletionJob.upsert({
        create: {
          storageKey
        },
        update: {},
        where: {
          storageKey
        }
      });
    }
  },
  resolveAuth: resolveRequestAuth,
  storage: createS3StorageAdapter()
});
