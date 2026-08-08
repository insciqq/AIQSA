// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { attachmentProcessingRepository } from "./defaultProcessing";

async function createProcessingAttachment(nextAttemptAt: Date) {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      displayName: "Attachment processing test",
      email: `attachment-processing-${suffix}@example.test`,
      status: "active"
    }
  });
  const attachment = await prisma.attachment.create({
    data: {
      byteSize: 4,
      checksum: "abcd",
      fileName: "report.docx",
      kind: "document",
      metadata: {},
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      processingJob: { create: { nextAttemptAt } },
      status: "processing",
      storageKey: `attachment-processing/${suffix}`,
      userId: user.id
    }
  });
  return { attachment, user };
}

describe("Prisma attachment processing repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("claims, heartbeats, releases, and reclaims one due job through its lease", async () => {
    const firstDue = new Date("1900-01-01T00:00:00.000Z");
    const retryDue = new Date("1900-01-01T00:01:00.000Z");
    const { attachment, user } = await createProcessingAttachment(firstDue);

    try {
      const first = await attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-lease-1",
        now: firstDue,
        staleBefore: new Date("1800-01-01T00:00:00.000Z")
      });
      expect(first).toMatchObject({
        attemptCount: 1,
        claimToken: "attachment-processing-lease-1",
        id: attachment.id
      });
      expect(await attachmentProcessingRepository.heartbeat({
        claimToken: "wrong-lease",
        jobId: first!.jobId,
        now: firstDue
      })).toBe(false);
      expect(await attachmentProcessingRepository.heartbeat({
        claimToken: first!.claimToken,
        jobId: first!.jobId,
        now: firstDue
      })).toBe(true);
      expect(await attachmentProcessingRepository.retryLater({
        claimToken: first!.claimToken,
        errorCode: "parser_unavailable",
        jobId: first!.jobId,
        nextAttemptAt: retryDue,
        now: firstDue
      })).toBe(true);

      await expect(attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-too-early",
        now: new Date("1900-01-01T00:00:59.999Z"),
        staleBefore: new Date("1800-01-01T00:00:00.000Z")
      })).resolves.toBeNull();
      await expect(attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-lease-2",
        now: retryDue,
        staleBefore: new Date("1800-01-01T00:00:00.000Z")
      })).resolves.toMatchObject({
        attemptCount: 2,
        claimToken: "attachment-processing-lease-2",
        id: attachment.id
      });
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("publishes terminal state only through the active database lease", async () => {
    const due = new Date("1901-01-01T00:00:00.000Z");
    const settledAt = new Date("1901-01-01T00:00:01.000Z");
    const { attachment, user } = await createProcessingAttachment(due);

    try {
      const claim = await attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-settle-lease",
        now: due,
        staleBefore: new Date("1800-01-01T00:00:00.000Z")
      });
      expect(claim).not.toBeNull();
      expect(await attachmentProcessingRepository.settleReady({
        attachmentId: attachment.id,
        claimToken: "wrong-lease",
        jobId: claim!.jobId,
        now: settledAt,
        result: { extractedText: "wrong", metadata: {} }
      })).toBe(false);
      expect(await attachmentProcessingRepository.settleFailed({
        attachmentId: attachment.id,
        claimToken: claim!.claimToken,
        errorCode: "parser_rejected",
        jobId: claim!.jobId,
        now: settledAt
      })).toBe(true);

      const [settled, job] = await Promise.all([
        prisma.attachment.findUnique({ where: { id: attachment.id } }),
        prisma.attachmentProcessingJob.findUnique({ where: { id: claim!.jobId } })
      ]);
      expect(settled).toMatchObject({
        extractedText: null,
        processingErrorCode: "parser_rejected",
        status: "failed"
      });
      expect(job).toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
});
