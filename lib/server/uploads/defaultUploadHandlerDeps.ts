import { Prisma } from "@prisma/client";
import { logEvent } from "../observability";
import { prisma } from "../prisma";
import { resolveProjectAccess } from "../projects/access";
import { workspaceAvailabilityService } from "../workspace/defaultServices";
import { getDefaultAttachmentProcessingCoordinator } from "./defaultProcessing";
import { UploadTargetUnavailableError, type UploadHandlerDeps } from "./handlers";
import { createS3StorageAdapter } from "./storage";

/**
 * The application's upload composition except authentication: persistence of
 * the attachment and its processing job, the Project target check, the
 * deletion outbox, storage and Workspace availability. The browser route and
 * in-process callers (a Telegram photo or document as its linked user) pair
 * it with their own resolver, so every upload passes the same checks.
 */
export const defaultUploadHandlerDeps: Omit<UploadHandlerDeps, "resolveAuth"> = {
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
          ...(input.status === "processing"
            ? {
                processingJob: {
                  create: { ownerUserId: input.processingOwnerUserId ?? input.userId }
                }
              }
            : {}),
          status: input.status,
          storageKey: input.storageKey,
          ...(input.projectId
            ? {
                project: { connect: { id: input.projectId } },
                uploader: { connect: { id: input.userId } },
                uploaderDisplayName: input.uploaderDisplayName ?? "Project member"
              }
            : { userId: input.userId })
        },
        include: { processingJob: { select: { id: true } } }
      });
    });
    if (attachment.processingJob) {
      logEvent("job_enqueued", { job_id: attachment.processingJob.id, subsystem: "attachments" });
    }

    return {
      byteSize: attachment.byteSize,
      checksum: attachment.checksum ?? input.checksum,
      extractedText: attachment.extractedText,
      fileName: attachment.fileName,
      id: attachment.id,
      kind: attachment.kind as "document" | "file" | "image" | "pdf",
      metadata: attachment.metadata,
      mimeType: attachment.mimeType,
      processingErrorCode: null,
      status: attachment.status as "processing" | "ready",
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
  storage: createS3StorageAdapter(),
  async workspaceScopeAvailable() {
    const snapshot = await workspaceAvailabilityService.snapshot();
    return snapshot.policy.enabled && snapshot.runtime.state === "ready";
  }
};
