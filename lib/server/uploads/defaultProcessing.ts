import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { createS3StorageAdapter } from "./storage";
import { createAttachmentProcessor, type AttachmentProcessingRecord } from "./processing";
import {
  AttachmentProcessingCoordinator,
  type AttachmentProcessingRepository
} from "./processingCoordinator";

type ClaimedRow = {
  attemptCount: number;
  byteSize: number;
  checksum: string | null;
  fileName: string;
  id: string;
  jobId: string;
  kind: string;
  mimeType: string;
  storageKey: string;
};

export const attachmentProcessingRepository: AttachmentProcessingRepository = {
  async claim(input) {
    const rows = await prisma.$transaction((tx) => tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
      WITH candidate AS (
        SELECT job."id"
        FROM "AttachmentProcessingJob" AS job
        INNER JOIN "Attachment" AS attachment ON attachment."id" = job."attachmentId"
        WHERE attachment."status" = 'processing'::"AttachmentStatus"
          AND job."nextAttemptAt" <= ${input.now}
          AND (job."claimedAt" IS NULL OR job."claimedAt" < ${input.staleBefore})
        ORDER BY job."nextAttemptAt" ASC, job."createdAt" ASC, job."id" ASC
        LIMIT 1
        FOR UPDATE OF job SKIP LOCKED
      ), claimed AS (
        UPDATE "AttachmentProcessingJob" AS job
        SET "claimToken" = ${input.claimToken},
            "claimedAt" = ${input.now},
            "lastAttemptAt" = ${input.now},
            "attemptCount" = job."attemptCount" + 1,
            "updatedAt" = ${input.now}
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job."id", job."attachmentId", job."attemptCount"
      )
      SELECT
        attachment."id",
        attachment."byteSize",
        attachment."checksum",
        attachment."fileName",
        attachment."kind",
        attachment."mimeType",
        attachment."storageKey",
        claimed."id" AS "jobId",
        claimed."attemptCount"
      FROM claimed
      INNER JOIN "Attachment" AS attachment ON attachment."id" = claimed."attachmentId"
    `));
    const row = rows[0];
    return row ? ({ ...row, claimToken: input.claimToken } satisfies AttachmentProcessingRecord) : null;
  },

  async heartbeat(input) {
    const updated = await prisma.attachmentProcessingJob.updateMany({
      data: {
        claimedAt: input.now
      },
      where: {
        claimToken: input.claimToken,
        id: input.jobId
      }
    });
    return updated.count === 1;
  },

  async retryLater(input) {
    const updated = await prisma.attachmentProcessingJob.updateMany({
      data: {
        claimedAt: null,
        claimToken: null,
        lastErrorCode: input.errorCode,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: input.now
      },
      where: {
        claimToken: input.claimToken,
        id: input.jobId
      }
    });
    return updated.count === 1;
  },

  async settleFailed(input) {
    return prisma.$transaction(async (tx) => {
      const lease = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"
        FROM "AttachmentProcessingJob"
        WHERE "id" = ${input.jobId}
          AND "attachmentId" = ${input.attachmentId}
          AND "claimToken" = ${input.claimToken}
        FOR UPDATE
      `);
      if (!lease[0]) return false;
      const updated = await tx.attachment.updateMany({
        data: {
          extractedText: null,
          processingErrorCode: input.errorCode,
          status: "failed",
          updatedAt: input.now
        },
        where: {
          id: input.attachmentId,
          status: "processing"
        }
      });
      if (updated.count !== 1) return false;
      await tx.attachmentProcessingJob.delete({ where: { id: input.jobId } });
      return true;
    });
  },

  async settleReady(input) {
    return prisma.$transaction(async (tx) => {
      const lease = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"
        FROM "AttachmentProcessingJob"
        WHERE "id" = ${input.jobId}
          AND "attachmentId" = ${input.attachmentId}
          AND "claimToken" = ${input.claimToken}
        FOR UPDATE
      `);
      if (!lease[0]) return false;
      const updated = await tx.attachment.updateMany({
        data: {
          extractedText: input.result.extractedText,
          metadata: input.result.metadata as Prisma.InputJsonValue,
          processingErrorCode: null,
          status: "ready",
          updatedAt: input.now
        },
        where: {
          id: input.attachmentId,
          status: "processing"
        }
      });
      if (updated.count !== 1) return false;
      await tx.attachmentProcessingJob.delete({ where: { id: input.jobId } });
      return true;
    });
  }
};

type AttachmentProcessingGlobal = typeof globalThis & {
  __aiqsaAttachmentProcessingCoordinator?: AttachmentProcessingCoordinator;
};

function createDefaultAttachmentProcessingCoordinator(): AttachmentProcessingCoordinator {
  const storage = createS3StorageAdapter();
  return new AttachmentProcessingCoordinator({
    process: createAttachmentProcessor({ storage }),
    repository: attachmentProcessingRepository
  });
}

export function getDefaultAttachmentProcessingCoordinator(): AttachmentProcessingCoordinator {
  const scope = globalThis as AttachmentProcessingGlobal;
  const coordinator = scope.__aiqsaAttachmentProcessingCoordinator ??
    createDefaultAttachmentProcessingCoordinator();
  scope.__aiqsaAttachmentProcessingCoordinator = coordinator;
  coordinator.start();
  return coordinator;
}

export function kickDefaultAttachmentProcessing(): void {
  getDefaultAttachmentProcessingCoordinator().kick();
}
