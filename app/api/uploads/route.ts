import {
  createUploadHandler,
  UploadTargetUnavailableError
} from "@/lib/server/uploads/handlers";
import { getDefaultAttachmentProcessingCoordinator } from "@/lib/server/uploads/defaultProcessing";
import { createS3StorageAdapter } from "@/lib/server/uploads/storage";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { resolveProjectAccess } from "@/lib/server/projects/access";
import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

export const POST = createUploadHandler({
  createAttachment: async (input) => {
    const attachment = await prisma.$transaction(async (tx) => {
      if (input.projectId) {
        await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE
        `);
        const access = await resolveProjectAccess(tx, {
          minimumRole: "CONTRIBUTOR",
          projectId: input.projectId,
          requireActive: true,
          userId: input.userId
        });
        if (!access) throw new UploadTargetUnavailableError();
      }
      return tx.attachment.create({
        data: {
          byteSize: input.byteSize,
          checksum: input.checksum,
          extractedText: input.extractedText,
          fileName: input.fileName,
          kind: input.kind,
          metadata: input.metadata as Prisma.InputJsonValue,
          mimeType: input.mimeType,
          processingErrorCode: input.processingErrorCode,
          processingJob: {
            create: { ownerUserId: input.processingOwnerUserId ?? input.userId }
          },
          status: input.status,
          storageKey: input.storageKey,
          ...(input.projectId
            ? {
                project: { connect: { id: input.projectId } },
                uploader: { connect: { id: input.userId } },
                uploaderDisplayName: input.uploaderDisplayName ?? "Project member"
              }
            : { userId: input.userId })
        }
      });
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
      processingErrorCode: null,
      status: "processing",
      storageKey: attachment.storageKey,
      updatedAt: attachment.updatedAt
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
  kickProcessing() {
    getDefaultAttachmentProcessingCoordinator().kick();
  },
  async resolveTarget({ projectId, userId }) {
    if (!projectId) return { projectId: null };
    const access = await resolveProjectAccess(prisma, {
      minimumRole: "CONTRIBUTOR",
      projectId,
      requireActive: true,
      userId
    });
    if (!access) return null;
    const user = await prisma.user.findUnique({
      select: { displayName: true },
      where: { id: userId }
    });
    return user
      ? { projectId, uploaderDisplayName: user.displayName }
      : null;
  },
  resolveAuth: resolveRequestAuth,
  storage: createS3StorageAdapter()
});
