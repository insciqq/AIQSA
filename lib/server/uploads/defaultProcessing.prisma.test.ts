// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
      processingJob: { create: { nextAttemptAt, ownerUserId: user.id } },
      status: "processing",
      storageKey: `attachment-processing/${suffix}`,
      userId: user.id
    }
  });
  return { attachment, user };
}

async function resetAttachmentFairnessCursor(lastGrantedOwnerUserId: string | null = null) {
  await prisma.documentProcessingFairnessCursor.upsert({
    create: { lastGrantedOwnerUserId, pipeline: "attachment" },
    update: { lastGrantedOwnerUserId },
    where: { pipeline: "attachment" }
  });
}

async function createFairnessUser(label: string) {
  const suffix = randomUUID();
  return prisma.user.create({
    data: {
      displayName: `Attachment fairness ${label}`,
      email: `attachment-fairness-${label}-${suffix}@example.test`,
      id: `attachment-fairness-${label}-${suffix}`,
      status: "active"
    }
  });
}

async function createOwnedProcessingAttachments(input: {
  count: number;
  createdAtOffset: number;
  nextAttemptAt: Date;
  userId: string;
}) {
  const attachments = [];
  for (let index = 0; index < input.count; index += 1) {
    const id = randomUUID();
    attachments.push(await prisma.attachment.create({
      data: {
        byteSize: 4,
        checksum: "abcd",
        fileName: `${id}.docx`,
        kind: "document",
        metadata: {},
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        processingJob: {
          create: {
            createdAt: new Date(input.createdAtOffset + index),
            nextAttemptAt: input.nextAttemptAt,
            ownerUserId: input.userId
          }
        },
        status: "processing",
        storageKey: `attachment-processing/${id}`,
        userId: input.userId
      },
      select: { id: true }
    }));
  }
  return attachments;
}

describe("Prisma attachment processing repository", () => {
  beforeEach(async () => {
    await resetAttachmentFairnessCursor();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("claims, heartbeats, releases, and reclaims one due job through its lease", async () => {
    const firstDue = new Date("2097-01-01T00:00:00.000Z");
    const retryDue = new Date("2097-01-01T00:01:00.000Z");
    const { attachment, user } = await createProcessingAttachment(firstDue);

    try {
      const first = await attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-lease-1",
        now: firstDue,
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
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
        now: new Date("2097-01-01T00:00:59.999Z"),
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
      })).resolves.toBeNull();
      await expect(attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-lease-2",
        now: retryDue,
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
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
    const due = new Date("2097-02-01T00:00:00.000Z");
    const settledAt = new Date("2097-02-01T00:00:01.000Z");
    const { attachment, user } = await createProcessingAttachment(due);

    try {
      const claim = await attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-settle-lease",
        now: due,
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
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

  it("rotates owners within the K-grant bound when a new backlog joins an older bulk import", async () => {
    const now = new Date("2100-01-01T00:00:00.000Z");
    const staleBefore = new Date("2000-01-01T00:00:00.000Z");
    const owners = await Promise.all([
      createFairnessUser("a"),
      createFairnessUser("b"),
      createFairnessUser("c")
    ]);
    const ownerByAttachment = new Map<string, string>();

    try {
      const ownerAWork = await createOwnedProcessingAttachments({
        count: 4,
        createdAtOffset: Date.parse("2099-01-01T00:00:00.000Z"),
        nextAttemptAt: new Date("2099-01-01T00:00:00.000Z"),
        userId: owners[0].id
      });
      ownerAWork.forEach(({ id }) => ownerByAttachment.set(id, owners[0].id));
      const initial = await attachmentProcessingRepository.claim({
        claimToken: randomUUID(),
        now,
        staleBefore
      });
      expect(ownerByAttachment.get(initial!.id)).toBe(owners[0].id);

      for (const [ownerIndex, owner] of owners.slice(1).entries()) {
        const work = await createOwnedProcessingAttachments({
          count: 3,
          createdAtOffset: Date.parse("2099-02-01T00:00:00.000Z") + ownerIndex * 100,
          nextAttemptAt: new Date("2099-02-01T00:00:00.000Z"),
          userId: owner.id
        });
        work.forEach(({ id }) => ownerByAttachment.set(id, owner.id));
      }

      const grants: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const claim = await attachmentProcessingRepository.claim({
          claimToken: randomUUID(),
          now,
          staleBefore
        });
        expect(claim).not.toBeNull();
        grants.push(ownerByAttachment.get(claim!.id)!);
      }
      expect(grants).toEqual([
        owners[1].id,
        owners[2].id,
        owners[0].id,
        owners[1].id,
        owners[2].id,
        owners[0].id
      ]);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: owners.map(({ id }) => id) } } });
    }
  });

  it("serializes racing claimers without duplicate grants or idle sole-owner capacity", async () => {
    const now = new Date("2101-01-01T00:00:00.000Z");
    const staleBefore = new Date("2000-01-01T00:00:00.000Z");
    const [ownerA, ownerB] = await Promise.all([
      createFairnessUser("race-a"),
      createFairnessUser("race-b")
    ]);
    const ownerByAttachment = new Map<string, string>();

    try {
      for (const [owner, offset] of [[ownerA, 0], [ownerB, 100]] as const) {
        const work = await createOwnedProcessingAttachments({
          count: 4,
          createdAtOffset: Date.parse("2100-01-01T00:00:00.000Z") + offset,
          nextAttemptAt: new Date("2100-01-01T00:00:00.000Z"),
          userId: owner.id
        });
        work.forEach(({ id }) => ownerByAttachment.set(id, owner.id));
      }
      await resetAttachmentFairnessCursor(ownerA.id);
      const raced = await Promise.all([0, 1].map(() => attachmentProcessingRepository.claim({
        claimToken: randomUUID(),
        now,
        staleBefore
      })));
      expect(new Set(raced.map((claim) => claim!.id)).size).toBe(2);
      expect(new Set(raced.map((claim) => ownerByAttachment.get(claim!.id)))).toEqual(
        new Set([ownerA.id, ownerB.id])
      );

      await prisma.user.delete({ where: { id: ownerB.id } });
      const soleOwnerClaims = await Promise.all([0, 1].map(() =>
        attachmentProcessingRepository.claim({
          claimToken: randomUUID(),
          now,
          staleBefore
        })
      ));
      expect(soleOwnerClaims.every((claim) =>
        claim !== null && ownerByAttachment.get(claim.id) === ownerA.id)).toBe(true);
      expect(new Set(soleOwnerClaims.map((claim) => claim!.id)).size).toBe(2);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id] } } });
    }
  });
});
