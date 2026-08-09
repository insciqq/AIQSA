import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";
import { kickDefaultAttachmentProcessing } from "@/lib/server/uploads/defaultProcessing";
import {
  createAttachmentRetryHandler,
  createAttachmentStatusHandler,
  type AttachmentLifecycleRecord,
  type AttachmentLifecycleRepository
} from "@/lib/server/uploads/lifecycleHandlers";

export const runtime = "nodejs";

const select = {
  byteSize: true,
  extractedText: true,
  fileName: true,
  id: true,
  kind: true,
  metadata: true,
  mimeType: true,
  processingErrorCode: true,
  status: true,
  updatedAt: true
} as const;

const repository: AttachmentLifecycleRepository = {
  async load(input) {
    return prisma.attachment.findFirst({
      select,
      where: {
        id: input.attachmentId,
        userId: input.userId
      }
    }) as Promise<AttachmentLifecycleRecord | null>;
  },

  async retry(input) {
    return prisma.$transaction(async (tx) => {
      const exists = await tx.attachment.findFirst({
        select: { id: true },
        where: { id: input.attachmentId, userId: input.userId }
      });
      if (!exists) return { kind: "not_found" as const };
      const updated = await tx.attachment.updateMany({
        data: {
          extractedText: null,
          metadata: {},
          processingErrorCode: null,
          status: "processing",
          updatedAt: input.now
        },
        where: {
          chatId: null,
          id: input.attachmentId,
          messageId: null,
          status: "failed",
          userId: input.userId
        }
      });
      if (updated.count !== 1) return { kind: "not_retryable" as const };
      await tx.attachmentProcessingJob.upsert({
        create: {
          attachmentId: input.attachmentId,
          nextAttemptAt: input.now,
          ownerUserId: input.userId
        },
        update: {
          attemptCount: 0,
          claimedAt: null,
          claimToken: null,
          lastAttemptAt: null,
          lastErrorCode: null,
          nextAttemptAt: input.now,
          updatedAt: input.now
        },
        where: { attachmentId: input.attachmentId }
      });
      const attachment = await tx.attachment.findUniqueOrThrow({
        select,
        where: { id: input.attachmentId }
      });
      return {
        attachment: attachment as AttachmentLifecycleRecord,
        kind: "retried" as const
      };
    });
  }
};

export const GET = createAttachmentStatusHandler({
  repository,
  resolveAuth: resolveRequestAuth
});

export const POST = createAttachmentRetryHandler({
  kickProcessing: kickDefaultAttachmentProcessing,
  repository,
  resolveAuth: resolveRequestAuth
});
