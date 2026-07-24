import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createMemoryStorageAdapter, createS3StorageAdapter } from "../uploads/storage";
import {
  createPrismaRetentionRepository,
  pruneRetention
} from "./prune";

const oldDate = new Date("2000-01-01T00:00:00.000Z");
const retentionNow = new Date("2000-02-15T00:00:00.000Z");

function startBarrier(parties: number) {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    waiting += 1;
    if (waiting === parties) {
      release();
    }
    await released;
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

async function createUser() {
  const id = randomUUID();

  return prisma.user.create({
    data: {
      displayName: "Retention Test",
      email: `retention-${id}@example.test`,
      status: "active"
    }
  });
}

async function createOldAttachment(userId: string, storageKey = `retention/${randomUUID()}`) {
  return prisma.attachment.create({
    data: {
      byteSize: 4,
      createdAt: oldDate,
      fileName: "retention.txt",
      kind: "document",
      metadata: {},
      mimeType: "text/plain",
      storageKey,
      userId
    }
  });
}

async function cleanupUser(userId: string, storageKeys: string[]) {
  await prisma.attachmentDeletionJob.deleteMany({
    where: {
      storageKey: {
        in: storageKeys
      }
    }
  });
  await prisma.user.deleteMany({ where: { id: userId } });
}

describe("Prisma attachment retention outbox", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("settles the run-link versus orphan-stage race with exactly one owner", async () => {
    const user = await createUser();
    const chat = await prisma.chat.create({
      data: {
        title: "Retention race",
        userId: user.id
      }
    });
    const attachment = await createOldAttachment(user.id);
    const repository = createPrismaRetentionRepository(prisma);
    const barrier = startBarrier(2);

    try {
      const [staged, linked] = await Promise.all([
        (async () => {
          await barrier();
          return repository.stageOrphanedAttachments({
            cutoff: new Date("2000-01-02T00:00:00.000Z"),
            limit: 1
          });
        })(),
        (async () => {
          await barrier();
          return prisma.attachment.updateMany({
            data: {
              chatId: chat.id,
              messageId: `retention-message-${randomUUID()}`
            },
            where: {
              chatId: null,
              id: attachment.id,
              messageId: null,
              userId: user.id
            }
          });
        })()
      ]);
      const [storedAttachment, deletionJob] = await Promise.all([
        prisma.attachment.findUnique({ where: { id: attachment.id } }),
        prisma.attachmentDeletionJob.findUnique({ where: { storageKey: attachment.storageKey } })
      ]);

      if (linked.count === 1) {
        expect(staged.rowsDeleted).toBe(0);
        expect(storedAttachment).toMatchObject({ chatId: chat.id });
        expect(deletionJob).toBeNull();
      } else {
        expect(linked.count).toBe(0);
        expect(staged).toMatchObject({ jobsStaged: 1, rowsDeleted: 1 });
        expect(storedAttachment).toBeNull();
        expect(deletionJob).not.toBeNull();
      }
    } finally {
      await cleanupUser(user.id, [attachment.storageKey]);
    }
  });

  it("keeps failed storage deletion durable and retries it idempotently", async () => {
    const user = await createUser();
    const storage = createMemoryStorageAdapter();
    const attachment = await createOldAttachment(user.id);
    await storage.putObject({
      body: Buffer.from("data"),
      contentType: "text/plain",
      storageKey: attachment.storageKey
    });
    const repository = createPrismaRetentionRepository(prisma);

    try {
      const failed = await pruneRetention({
        batchSize: 10,
        dryRun: false,
        now: retentionNow,
        repository,
        storage: {
          async deleteObject() {
            throw new Error("private storage detail");
          }
        }
      });
      const retryable = await prisma.attachmentDeletionJob.findUniqueOrThrow({
        where: { storageKey: attachment.storageKey }
      });

      expect(failed.attachmentDeletionJobs.failedJobs).toEqual([
        { code: "object_delete_failed", id: retryable.id }
      ]);
      expect(JSON.stringify(failed)).not.toContain(attachment.storageKey);
      expect(await prisma.attachment.findUnique({ where: { id: attachment.id } })).toBeNull();
      expect(retryable).toMatchObject({
        attemptCount: 1,
        claimedAt: null,
        claimToken: null,
        lastErrorCode: "object_delete_failed"
      });

      const retried = await pruneRetention({
        batchSize: 10,
        dryRun: false,
        now: retentionNow,
        repository,
        storage
      });

      expect(retried.attachmentDeletionJobs).toMatchObject({
        claimed: 1,
        completed: 1,
        objectsDeleted: 1
      });
      expect(storage.objects.has(attachment.storageKey)).toBe(false);
      await expect(
        prisma.attachmentDeletionJob.findUnique({ where: { storageKey: attachment.storageKey } })
      ).resolves.toBeNull();
    } finally {
      await cleanupUser(user.id, [attachment.storageKey]);
    }
  });

  it("recovers a stale claim after object deletion but before durable acknowledgement", async () => {
    const user = await createUser();
    const storage = createMemoryStorageAdapter();
    const attachment = await createOldAttachment(user.id);
    const repository = createPrismaRetentionRepository(prisma);
    await storage.putObject({
      body: Buffer.from("data"),
      contentType: "text/plain",
      storageKey: attachment.storageKey
    });

    try {
      await repository.stageOrphanedAttachments({
        cutoff: new Date("2000-01-02T00:00:00.000Z"),
        limit: 1
      });
      const firstClaim = await repository.claimAttachmentDeletionJobs({
        claimableBefore: new Date("1999-12-31T00:00:00.000Z"),
        limit: 1,
        now: retentionNow
      });
      expect(firstClaim).toHaveLength(1);
      await storage.deleteObject(firstClaim[0]!.storageKey);

      const retryNow = new Date(retentionNow.getTime() + 20 * 60 * 1000);
      const secondClaim = await repository.claimAttachmentDeletionJobs({
        claimableBefore: new Date(retentionNow.getTime() + 1),
        limit: 1,
        now: retryNow
      });
      expect(secondClaim.map((claim) => claim.id)).toEqual([firstClaim[0]!.id]);
      await storage.deleteObject(secondClaim[0]!.storageKey);
      await expect(repository.completeAttachmentDeletionJob(secondClaim[0]!)).resolves.toBe(true);
      await expect(
        prisma.attachmentDeletionJob.findUnique({ where: { id: secondClaim[0]!.id } })
      ).resolves.toBeNull();
    } finally {
      await cleanupUser(user.id, [attachment.storageKey]);
    }
  });

  it("lets concurrent pruners claim an object job only once", async () => {
    const user = await createUser();
    const attachment = await createOldAttachment(user.id);
    const repository = createPrismaRetentionRepository(prisma);
    await repository.stageOrphanedAttachments({
      cutoff: new Date("2000-01-02T00:00:00.000Z"),
      limit: 1
    });
    const deletionStarted = deferred();
    const releaseDeletion = deferred();
    let deleteCalls = 0;
    const storage = {
      async deleteObject() {
        deleteCalls += 1;
        deletionStarted.resolve();
        await releaseDeletion.promise;
      }
    };

    try {
      const first = pruneRetention({ dryRun: false, now: retentionNow, repository, storage });
      await deletionStarted.promise;
      const second = await pruneRetention({ dryRun: false, now: retentionNow, repository, storage });
      expect(second.attachmentDeletionJobs.claimed).toBe(0);
      releaseDeletion.resolve();
      expect((await first).attachmentDeletionJobs.completed).toBe(1);
      expect(deleteCalls).toBe(1);
    } finally {
      releaseDeletion.resolve();
      await cleanupUser(user.id, [attachment.storageKey]);
    }
  });

  it("drains a durable deletion job against the configured private object store", async () => {
    const storage = createS3StorageAdapter();
    const storageKey = `retention/integration-${randomUUID()}.txt`;
    const job = await prisma.attachmentDeletionJob.create({ data: { storageKey } });
    await storage.putObject({
      body: Buffer.from("retention integration"),
      contentType: "text/plain",
      storageKey
    });

    try {
      const summary = await pruneRetention({
        batchSize: 1,
        dryRun: false,
        now: retentionNow,
        repository: createPrismaRetentionRepository(prisma),
        storage
      });

      expect(summary.attachmentDeletionJobs).toMatchObject({
        claimed: 1,
        completed: 1,
        objectsDeleted: 1
      });
      await expect(storage.getObject(storageKey)).rejects.toBeInstanceOf(Error);
      await expect(prisma.attachmentDeletionJob.findUnique({ where: { id: job.id } })).resolves.toBeNull();
    } finally {
      await storage.deleteObject(storageKey).catch(() => undefined);
      await prisma.attachmentDeletionJob.deleteMany({ where: { id: job.id } });
    }
  });

  it("keeps dry-run read-only in the real database", async () => {
    const user = await createUser();
    const attachment = await createOldAttachment(user.id);
    const jobKey = `retention/dry-job-${randomUUID()}`;
    const job = await prisma.attachmentDeletionJob.create({ data: { storageKey: jobKey } });
    const session = await prisma.authSession.create({
      data: {
        createdAt: oldDate,
        expiresAt: oldDate,
        tokenHash: `retention-session-${randomUUID()}`,
        userId: user.id
      }
    });
    const flowToken = await prisma.authFlowToken.create({
      data: {
        createdAt: oldDate,
        expiresAt: oldDate,
        purpose: "password_reset",
        tokenHash: `retention-flow-${randomUUID()}`,
        userId: user.id
      }
    });
    let storageCalls = 0;

    try {
      const summary = await pruneRetention({
        dryRun: true,
        now: retentionNow,
        repository: createPrismaRetentionRepository(prisma),
        storage: {
          async deleteObject() {
            storageCalls += 1;
          }
        }
      });

      expect(summary).toMatchObject({
        attachmentDeletionJobs: { claimed: 0 },
        authFlowTokens: { deleted: 0 },
        authSessions: { deleted: 0 },
        dryRun: true,
        orphanedAttachments: { rowsDeleted: 0 }
      });
      expect(storageCalls).toBe(0);
      await expect(prisma.attachment.findUnique({ where: { id: attachment.id } })).resolves.not.toBeNull();
      await expect(prisma.attachmentDeletionJob.findUnique({ where: { id: job.id } })).resolves.toMatchObject({
        attemptCount: 0,
        claimedAt: null
      });
      await expect(prisma.authSession.findUnique({ where: { id: session.id } })).resolves.not.toBeNull();
      await expect(prisma.authFlowToken.findUnique({ where: { id: flowToken.id } })).resolves.not.toBeNull();
    } finally {
      await cleanupUser(user.id, [attachment.storageKey, jobKey]);
    }
  });

  it("prunes only old terminal auth state and respects the requested batch", async () => {
    const user = await createUser();
    const repository = createPrismaRetentionRepository(prisma);
    const cutoff = new Date("2026-06-18T00:00:00.000Z");
    const oldRevoked = await prisma.authSession.create({
      data: {
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        revokedAt: new Date("2026-05-01T00:00:00.000Z"),
        tokenHash: `old-revoked-${randomUUID()}`,
        userId: user.id
      }
    });
    const active = await prisma.authSession.create({
      data: {
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        tokenHash: `active-${randomUUID()}`,
        userId: user.id
      }
    });
    const recentRevoked = await prisma.authSession.create({
      data: {
        expiresAt: new Date("2026-05-01T00:00:00.000Z"),
        revokedAt: new Date("2026-07-01T00:00:00.000Z"),
        tokenHash: `recent-revoked-${randomUUID()}`,
        userId: user.id
      }
    });
    const oldConsumed = await prisma.authFlowToken.create({
      data: {
        consumedAt: new Date("2026-05-01T00:00:00.000Z"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        purpose: "password_reset",
        tokenHash: `old-consumed-${randomUUID()}`,
        userId: user.id
      }
    });
    const unexpired = await prisma.authFlowToken.create({
      data: {
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        purpose: "password_reset",
        tokenHash: `unexpired-${randomUUID()}`,
        userId: user.id
      }
    });
    const recentConsumed = await prisma.authFlowToken.create({
      data: {
        consumedAt: new Date("2026-07-01T00:00:00.000Z"),
        expiresAt: new Date("2026-05-01T00:00:00.000Z"),
        purpose: "password_reset",
        tokenHash: `recent-consumed-${randomUUID()}`,
        userId: user.id
      }
    });

    try {
      const sessionIds = await repository.findPrunableAuthSessionIds({ cutoff, limit: 1 });
      const flowTokenIds = await repository.findPrunableAuthFlowTokenIds({ cutoff, limit: 1 });
      expect(sessionIds).toEqual([oldRevoked.id]);
      expect(flowTokenIds).toEqual([oldConsumed.id]);
      await repository.deleteAuthSessions({ cutoff, ids: sessionIds });
      await repository.deleteAuthFlowTokens({ cutoff, ids: flowTokenIds });

      await expect(prisma.authSession.findUnique({ where: { id: active.id } })).resolves.not.toBeNull();
      await expect(prisma.authSession.findUnique({ where: { id: recentRevoked.id } })).resolves.not.toBeNull();
      await expect(prisma.authFlowToken.findUnique({ where: { id: unexpired.id } })).resolves.not.toBeNull();
      await expect(prisma.authFlowToken.findUnique({ where: { id: recentConsumed.id } })).resolves.not.toBeNull();
    } finally {
      await cleanupUser(user.id, []);
    }
  });
});
