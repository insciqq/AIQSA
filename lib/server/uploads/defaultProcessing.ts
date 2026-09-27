import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { retainDatabaseFailure } from "../observability/databaseFailure";
import { createS3StorageAdapter } from "./storage";
import { createAttachmentProcessor, type AttachmentProcessingRecord } from "./processing";
import {
  ATTACHMENT_PROCESSING_ATTEMPTS_EXHAUSTED,
  AttachmentProcessingCoordinator,
  validAttachmentProcessingMaxAttempts,
  type AttachmentProcessingExhaustedJob,
  type AttachmentProcessingRepository
} from "./processingCoordinator";

const ATTACHMENT_EXHAUSTED_SETTLEMENT_BATCH = 16;

type ClaimedRow = {
  attemptCount: number;
  byteSize: number;
  checksum: string | null;
  fileName: string;
  id: string;
  jobId: string;
  kind: string;
  mimeType: string;
  ownerUserId: string;
  storageKey: string;
};

type FairnessCursorRow = Readonly<{
  lastGrantedOwnerUserId: string | null;
}>;

type ExhaustedRow = Readonly<{
  attemptCount: number;
  jobId: string;
}>;

async function lockAttachmentFairnessCursor(
  tx: Prisma.TransactionClient
): Promise<string | null> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "DocumentProcessingFairnessCursor" (
      "pipeline", "lastGrantedOwnerUserId", "updatedAt"
    ) VALUES ('attachment', NULL, CURRENT_TIMESTAMP)
    ON CONFLICT ("pipeline") DO NOTHING
  `);
  const rows = await tx.$queryRaw<FairnessCursorRow[]>(Prisma.sql`
    SELECT "lastGrantedOwnerUserId"
    FROM "DocumentProcessingFairnessCursor"
    WHERE "pipeline" = 'attachment'
    FOR UPDATE
  `);
  if (!rows[0]) throw new Error("attachment_fairness_cursor_unavailable");
  return rows[0].lastGrantedOwnerUserId;
}

/**
 * A job that used every attempt without settling (for example because the
 * process died while parsing) fails visibly once its lease is stale instead of
 * being reclaimed forever. A live lease or a scheduled retry is left alone.
 */
async function settleExhaustedAttachmentJobs(
  tx: Prisma.TransactionClient,
  input: Readonly<{ maxAttempts: number; now: Date; staleBefore: Date }>
): Promise<readonly AttachmentProcessingExhaustedJob[]> {
  const rows = await tx.$queryRaw<ExhaustedRow[]>(Prisma.sql`
    WITH exhausted AS MATERIALIZED (
      SELECT job."id", job."attachmentId"
      FROM "AttachmentProcessingJob" AS job
      INNER JOIN "Attachment" AS attachment
        ON attachment."id" = job."attachmentId"
        AND (attachment."userId" = job."ownerUserId"
          OR attachment."projectId" IS NOT NULL)
      WHERE attachment."status" = 'processing'::"AttachmentStatus"
        AND job."attemptCount" >= ${input.maxAttempts}
        AND job."nextAttemptAt" <= ${input.now}
        AND (job."claimedAt" IS NULL OR job."claimedAt" < ${input.staleBefore})
      ORDER BY job."nextAttemptAt", job."createdAt", job."id"
      LIMIT ${ATTACHMENT_EXHAUSTED_SETTLEMENT_BATCH}
      FOR UPDATE OF job, attachment SKIP LOCKED
    ), failed AS (
      UPDATE "Attachment" AS attachment
      SET "extractedText" = NULL,
          "processingErrorCode" = ${ATTACHMENT_PROCESSING_ATTEMPTS_EXHAUSTED},
          "status" = 'failed'::"AttachmentStatus",
          "updatedAt" = ${input.now}
      FROM exhausted
      WHERE attachment."id" = exhausted."attachmentId"
        AND attachment."status" = 'processing'::"AttachmentStatus"
      RETURNING attachment."id"
    ), removed AS (
      DELETE FROM "AttachmentProcessingJob" AS job
      USING exhausted
      INNER JOIN failed ON failed."id" = exhausted."attachmentId"
      WHERE job."id" = exhausted."id"
      RETURNING job."id", job."attemptCount"
    )
    SELECT removed."id" AS "jobId", removed."attemptCount"
    FROM removed
    ORDER BY removed."id"
  `);
  return Object.freeze(rows.map((row) => Object.freeze({
    attemptCount: row.attemptCount,
    jobId: row.jobId
  })));
}

export const attachmentProcessingRepository: AttachmentProcessingRepository = {
  async claim(input) {
    if (!validAttachmentProcessingMaxAttempts(input.maxAttempts)) {
      throw new RangeError("attachment_processing_max_attempts_invalid");
    }
    const { exhausted, row } = await prisma.$transaction(async (tx) => {
      const lastGrantedOwnerUserId = await lockAttachmentFairnessCursor(tx);
      const exhausted = await settleExhaustedAttachmentJobs(tx, input);
      const candidateCtes = lastGrantedOwnerUserId === null
        ? Prisma.sql`
            candidate AS MATERIALIZED (
              SELECT job."id"
              FROM "AttachmentProcessingJob" AS job
              INNER JOIN "Attachment" AS attachment
                ON attachment."id" = job."attachmentId"
                AND (attachment."userId" = job."ownerUserId"
                  OR attachment."projectId" IS NOT NULL)
              WHERE attachment."status" = 'processing'::"AttachmentStatus"
                AND job."attemptCount" < ${input.maxAttempts}
                AND job."nextAttemptAt" <= ${input.now}
                AND (job."claimedAt" IS NULL OR job."claimedAt" < ${input.staleBefore})
              ORDER BY
                job."nextAttemptAt",
                job."createdAt",
                job."ownerUserId",
                job."id"
              LIMIT 1
              FOR UPDATE OF job SKIP LOCKED
            )
          `
        : Prisma.sql`
            after_cursor AS MATERIALIZED (
              SELECT job."id"
              FROM "AttachmentProcessingJob" AS job
              INNER JOIN "Attachment" AS attachment
                ON attachment."id" = job."attachmentId"
                AND (attachment."userId" = job."ownerUserId"
                  OR attachment."projectId" IS NOT NULL)
              WHERE attachment."status" = 'processing'::"AttachmentStatus"
                AND job."ownerUserId" > ${lastGrantedOwnerUserId}
                AND job."attemptCount" < ${input.maxAttempts}
                AND job."nextAttemptAt" <= ${input.now}
                AND (job."claimedAt" IS NULL OR job."claimedAt" < ${input.staleBefore})
              ORDER BY
                job."ownerUserId",
                job."nextAttemptAt",
                job."createdAt",
                job."id"
              LIMIT 1
              FOR UPDATE OF job SKIP LOCKED
            ),
            wrapped AS MATERIALIZED (
              SELECT job."id"
              FROM "AttachmentProcessingJob" AS job
              INNER JOIN "Attachment" AS attachment
                ON attachment."id" = job."attachmentId"
                AND (attachment."userId" = job."ownerUserId"
                  OR attachment."projectId" IS NOT NULL)
              WHERE NOT EXISTS (SELECT 1 FROM after_cursor)
                AND attachment."status" = 'processing'::"AttachmentStatus"
                AND job."ownerUserId" <= ${lastGrantedOwnerUserId}
                AND job."attemptCount" < ${input.maxAttempts}
                AND job."nextAttemptAt" <= ${input.now}
                AND (job."claimedAt" IS NULL OR job."claimedAt" < ${input.staleBefore})
              ORDER BY
                job."ownerUserId",
                job."nextAttemptAt",
                job."createdAt",
                job."id"
              LIMIT 1
              FOR UPDATE OF job SKIP LOCKED
            ),
            candidate AS MATERIALIZED (
              SELECT "id" FROM after_cursor
              UNION ALL
              SELECT "id" FROM wrapped
            )
          `;
      const rows = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
        WITH ${candidateCtes}, claimed AS (
          UPDATE "AttachmentProcessingJob" AS job
          SET "claimToken" = ${input.claimToken},
              "claimedAt" = ${input.now},
              "lastAttemptAt" = ${input.now},
              "attemptCount" = job."attemptCount" + 1,
              "updatedAt" = ${input.now}
          FROM candidate
          WHERE job."id" = candidate."id"
          RETURNING job."id", job."attachmentId", job."ownerUserId", job."attemptCount"
        )
        SELECT
          attachment."id",
          attachment."byteSize",
          attachment."checksum",
          attachment."fileName",
          attachment."kind",
          attachment."mimeType",
          claimed."ownerUserId",
          attachment."storageKey",
          claimed."id" AS "jobId",
          claimed."attemptCount"
        FROM claimed
        INNER JOIN "Attachment" AS attachment
          ON attachment."id" = claimed."attachmentId"
          AND (attachment."userId" = claimed."ownerUserId"
            OR attachment."projectId" IS NOT NULL)
      `);
      const claimed = rows[0];
      if (!claimed) return { exhausted, row: null };
      const advanced = await tx.$executeRaw(Prisma.sql`
        UPDATE "DocumentProcessingFairnessCursor"
        SET "lastGrantedOwnerUserId" = ${claimed.ownerUserId},
            "updatedAt" = ${input.now}
        WHERE "pipeline" = 'attachment'
      `);
      if (advanced !== 1) throw new Error("attachment_fairness_cursor_lost");
      return { exhausted, row: claimed };
    }).catch(retainDatabaseFailure);
    return Object.freeze({
      exhausted,
      record: row ? ({
        attemptCount: row.attemptCount,
        byteSize: row.byteSize,
        checksum: row.checksum,
        claimToken: input.claimToken,
        fileName: row.fileName,
        id: row.id,
        jobId: row.jobId,
        kind: row.kind,
        mimeType: row.mimeType,
        storageKey: row.storageKey
      } satisfies AttachmentProcessingRecord) : null
    });
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
    }).catch(retainDatabaseFailure);
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
    }).catch(retainDatabaseFailure);
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
    }).catch(retainDatabaseFailure);
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
    }).catch(retainDatabaseFailure);
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
