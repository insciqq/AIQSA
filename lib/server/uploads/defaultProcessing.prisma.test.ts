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

const exhaustedOutcome = {
  attachment: {
    extractedText: null,
    processingErrorCode: "attachment_processing_attempts_exhausted",
    status: "failed"
  },
  job: null
};

async function exhaustedState(attachmentId: string, jobId: string) {
  const [attachment, job] = await Promise.all([
    prisma.attachment.findUnique({
      select: { extractedText: true, processingErrorCode: true, status: true },
      where: { id: attachmentId }
    }),
    prisma.attachmentProcessingJob.findUnique({ where: { id: jobId } })
  ]);
  return { attachment, job };
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
      const first = (await attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-lease-1",
        maxAttempts: 3,
        now: firstDue,
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
      })).record;
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
        maxAttempts: 3,
        now: new Date("2097-01-01T00:00:59.999Z"),
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
      })).resolves.toMatchObject({ record: null });
      await expect(attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-lease-2",
        maxAttempts: 3,
        now: retryDue,
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
      })).resolves.toMatchObject({
        record: {
          attemptCount: 2,
          claimToken: "attachment-processing-lease-2",
          id: attachment.id
        }
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
      const claim = (await attachmentProcessingRepository.claim({
        claimToken: "attachment-processing-settle-lease",
        maxAttempts: 3,
        now: due,
        staleBefore: new Date("2096-01-01T00:00:00.000Z")
      })).record;
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
      const initial = (await attachmentProcessingRepository.claim({
        claimToken: randomUUID(),
        maxAttempts: 3,
        now,
        staleBefore
      })).record;
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
        const claim = (await attachmentProcessingRepository.claim({
          claimToken: randomUUID(),
          maxAttempts: 3,
          now,
          staleBefore
        })).record;
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
      const raced = await Promise.all([0, 1].map(async () => (await attachmentProcessingRepository.claim({
        claimToken: randomUUID(),
        maxAttempts: 3,
        now,
        staleBefore
      })).record));
      expect(new Set(raced.map((claim) => claim!.id)).size).toBe(2);
      expect(new Set(raced.map((claim) => ownerByAttachment.get(claim!.id)))).toEqual(
        new Set([ownerA.id, ownerB.id])
      );

      await prisma.user.delete({ where: { id: ownerB.id } });
      const soleOwnerClaims = await Promise.all([0, 1].map(async () =>
        (await attachmentProcessingRepository.claim({
          claimToken: randomUUID(),
          maxAttempts: 3,
          now,
          staleBefore
        })).record
      ));
      expect(soleOwnerClaims.every((claim) =>
        claim !== null && ownerByAttachment.get(claim.id) === ownerA.id)).toBe(true);
      expect(new Set(soleOwnerClaims.map((claim) => claim!.id)).size).toBe(2);
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id] } } });
    }
  });

  it("fails a stale job whose attempts are spent and removes it instead of reclaiming", async () => {
    const due = new Date("2102-01-01T00:00:00.000Z");
    const { attachment, user } = await createProcessingAttachment(due);

    try {
      const job = await prisma.attachmentProcessingJob.update({
        data: {
          attemptCount: 3,
          claimToken: "crashed-worker-lease",
          claimedAt: new Date("2101-12-31T23:00:00.000Z")
        },
        where: { attachmentId: attachment.id }
      });
      const claim = await attachmentProcessingRepository.claim({
        claimToken: "attachment-exhausted-claim",
        maxAttempts: 3,
        now: due,
        staleBefore: new Date("2101-12-31T23:59:30.000Z")
      });

      expect(claim.exhausted).toContainEqual({ attemptCount: 3, jobId: job.id });
      expect(claim.record?.id).not.toBe(attachment.id);
      await expect(exhaustedState(attachment.id, job.id)).resolves.toEqual(exhaustedOutcome);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("closes the final attempt after its worker dies once the lease is stale", async () => {
    const due = new Date("2103-01-01T00:00:00.000Z");
    const { attachment, user } = await createProcessingAttachment(due);

    try {
      await prisma.attachmentProcessingJob.update({
        data: { attemptCount: 2 },
        where: { attachmentId: attachment.id }
      });
      const final = (await attachmentProcessingRepository.claim({
        claimToken: "attachment-final-attempt",
        maxAttempts: 3,
        now: due,
        staleBefore: new Date("2102-12-31T23:59:30.000Z")
      })).record;
      expect(final).toMatchObject({ attemptCount: 3, id: attachment.id });

      // The parser worker dies without settling; a live lease is never taken over.
      const duringLease = await attachmentProcessingRepository.claim({
        claimToken: "attachment-during-lease",
        maxAttempts: 3,
        now: new Date("2103-01-01T00:00:10.000Z"),
        staleBefore: new Date("2102-12-31T23:59:40.000Z")
      });
      expect(duringLease.exhausted.map(({ jobId }) => jobId)).not.toContain(final!.jobId);
      expect(duringLease.record?.id).not.toBe(attachment.id);
      await expect(prisma.attachmentProcessingJob.findUnique({ where: { id: final!.jobId } }))
        .resolves.toMatchObject({ attemptCount: 3, claimToken: "attachment-final-attempt" });

      const afterLease = await attachmentProcessingRepository.claim({
        claimToken: "attachment-after-lease",
        maxAttempts: 3,
        now: new Date("2103-01-01T00:01:00.000Z"),
        staleBefore: new Date("2103-01-01T00:00:30.000Z")
      });
      expect(afterLease.exhausted).toContainEqual({ attemptCount: 3, jobId: final!.jobId });
      expect(afterLease.record?.id).not.toBe(attachment.id);
      await expect(exhaustedState(attachment.id, final!.jobId)).resolves.toEqual(exhaustedOutcome);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("closes a legacy job that was reclaimed beyond the bound on its first claim", async () => {
    const due = new Date("2104-01-01T00:00:00.000Z");
    const { attachment, user } = await createProcessingAttachment(due);

    try {
      const job = await prisma.attachmentProcessingJob.update({
        data: {
          attemptCount: 50,
          claimToken: "legacy-crash-loop-lease",
          claimedAt: new Date("2103-12-31T00:00:00.000Z")
        },
        where: { attachmentId: attachment.id }
      });
      const claim = await attachmentProcessingRepository.claim({
        claimToken: "attachment-legacy-claim",
        maxAttempts: 3,
        now: due,
        staleBefore: new Date("2103-12-31T23:59:30.000Z")
      });

      expect(claim.exhausted).toContainEqual({ attemptCount: 50, jobId: job.id });
      expect(claim.record?.id).not.toBe(attachment.id);
      await expect(exhaustedState(attachment.id, job.id)).resolves.toEqual(exhaustedOutcome);
    } finally {
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  });

  it("leaves live leases, scheduled retries and settled attachments untouched", async () => {
    const now = new Date("2105-01-01T00:00:00.000Z");
    const staleBefore = new Date("2104-12-31T23:59:30.000Z");
    const live = await createProcessingAttachment(now);
    const scheduled = await createProcessingAttachment(new Date("2105-01-01T00:05:00.000Z"));
    const settled = await createProcessingAttachment(now);

    try {
      await prisma.attachmentProcessingJob.update({
        data: { attemptCount: 3, claimToken: "live-lease", claimedAt: now },
        where: { attachmentId: live.attachment.id }
      });
      await prisma.attachmentProcessingJob.update({
        data: { attemptCount: 3 },
        where: { attachmentId: scheduled.attachment.id }
      });
      await prisma.attachmentProcessingJob.update({
        data: { attemptCount: 3, claimToken: "settled-lease", claimedAt: new Date("2104-12-01T00:00:00.000Z") },
        where: { attachmentId: settled.attachment.id }
      });
      await prisma.attachment.update({
        data: { status: "ready" },
        where: { id: settled.attachment.id }
      });
      const ids = [live, scheduled, settled].map(({ attachment }) => attachment.id);
      const jobIds = (await prisma.attachmentProcessingJob.findMany({
        select: { id: true },
        where: { attachmentId: { in: ids } }
      })).map(({ id }) => id);

      const claim = await attachmentProcessingRepository.claim({
        claimToken: "attachment-untouched-claim",
        maxAttempts: 3,
        now,
        staleBefore
      });

      expect(ids).not.toContain(claim.record?.id);
      const jobs = await prisma.attachmentProcessingJob.findMany({
        select: { attachmentId: true, attemptCount: true },
        where: { attachmentId: { in: ids } }
      });
      expect(claim.exhausted.filter(({ jobId }) => jobIds.includes(jobId))).toEqual([]);
      expect(jobs).toHaveLength(3);
      expect(jobs.every(({ attemptCount }) => attemptCount === 3)).toBe(true);
      const attachments = await prisma.attachment.findMany({
        select: { id: true, processingErrorCode: true, status: true },
        where: { id: { in: ids } }
      });
      expect(new Map(attachments.map(({ id, processingErrorCode, status }) =>
        [id, { processingErrorCode, status }]))).toEqual(new Map([
        [live.attachment.id, { processingErrorCode: null, status: "processing" }],
        [scheduled.attachment.id, { processingErrorCode: null, status: "processing" }],
        [settled.attachment.id, { processingErrorCode: null, status: "ready" }]
      ]));
    } finally {
      await prisma.user.deleteMany({
        where: { id: { in: [live.user.id, scheduled.user.id, settled.user.id] } }
      });
    }
  });

  it("rejects attempt bounds outside the supported range before touching jobs", async () => {
    for (const maxAttempts of [0, 21]) {
      await expect(attachmentProcessingRepository.claim({
        claimToken: "attachment-invalid-bound",
        maxAttempts,
        now: new Date("2106-01-01T00:00:00.000Z"),
        staleBefore: new Date("2105-12-31T23:59:30.000Z")
      })).rejects.toThrow("attachment_processing_max_attempts_invalid");
    }
  });
});
