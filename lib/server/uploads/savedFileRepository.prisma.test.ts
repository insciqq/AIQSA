// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaRetentionRepository } from "../retention/prune";
import { createPrismaAttachmentLibraryRepository } from "./libraryRepository";
import { createSavedFileRepository } from "./savedFileRepository";

const old = new Date("2000-01-01T00:00:00Z");
const cutoff = new Date("2000-02-01T00:00:00Z");

async function fixture() {
  const user = await prisma.user.create({ data: { displayName: "Saved files test", id: `saved-file-${randomUUID()}` } });
  const source = await prisma.attachment.create({ data: {
    byteSize: 4, checksum: "a".repeat(64), createdAt: old, fileName: "template.docx", kind: "file",
    metadata: {}, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    storageKey: `saved-file-test/${randomUUID()}`, userId: user.id
  } });
  return {
    source, user,
    async cleanup() {
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: source.storageKey } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  };
}

async function waitForObjectLock(key: string, count: number) {
  await expect.poll(async () => {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS count FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND classid = ((hashtextextended(${key}, 260) >> 32) & 4294967295)::oid
        AND objid = (hashtextextended(${key}, 260) & 4294967295)::oid
    `);
    return row?.count;
  }, { timeout: 10_000, interval: 25 }).toBe(count);
}

describe("saved file lifecycle in PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("retains a saved original independently, reuses a new identity and enforces the owner/binding boundary", async () => {
    const value = await fixture();
    const repository = createSavedFileRepository(prisma);
    try {
      const saved = await repository.copy({ attachmentId: value.source.id, save: true, userId: value.user.id });
      expect(saved).not.toBeNull();
      expect(saved!.id).not.toBe(value.source.id);
      const savedId = saved!.id;
      expect((await repository.copy({ attachmentId: value.source.id, save: true, userId: value.user.id }))?.id).toBe(savedId);
      expect(await repository.copy({ attachmentId: savedId, save: false, userId: "other-owner" })).toBeNull();
      const reused = await repository.copy({ attachmentId: savedId, save: false, userId: value.user.id });
      expect(reused!.id).not.toBe(savedId);
      const chat = await prisma.chat.create({ data: { title: "Use a saved template", userId: value.user.id } });
      const message = await prisma.message.create({ data: { chatId: chat.id, content: {}, role: "user" } });
      await expect(prisma.attachment.update({ where: { id: savedId }, data: { chatId: chat.id, messageId: message.id } })).rejects.toThrow();
      await prisma.attachment.update({ where: { id: reused!.id }, data: { chatId: chat.id, messageId: message.id } });
      const retention = createPrismaRetentionRepository(prisma);
      expect(await retention.inspectOrphanedAttachments({ cutoff, limit: 10 })).toMatchObject({ matched: 1, shared: 1 });
      await retention.stageOrphanedAttachments({ cutoff, limit: 10 });
      expect(await prisma.attachment.findUnique({ where: { id: value.source.id } })).toBeNull();
      expect(await prisma.attachmentDeletionJob.findUnique({ where: { storageKey: value.source.storageKey } })).toBeNull();
      expect(await prisma.attachment.findUnique({ where: { id: savedId } })).toMatchObject({ savedAt: expect.any(Date), storageKey: value.source.storageKey });
      expect(await createPrismaAttachmentLibraryRepository(prisma).listSent({ limit: 200, userId: value.user.id })).toEqual([
        expect.objectContaining({ id: savedId, chatId: null, messageId: null, savedAt: expect.any(Date) })
      ]);
      expect(await repository.remove({ attachmentId: savedId, userId: "other-owner" })).toBe(false);
      expect(await repository.remove({ attachmentId: savedId, userId: value.user.id })).toBe(true);
      expect(await prisma.attachment.findUnique({ where: { id: reused!.id } })).toMatchObject({ chatId: chat.id, savedAt: null, checksum: value.source.checksum });
    } finally { await value.cleanup(); }
  });

  it.each(["save", "prune"] as const)("serializes %s first against concurrent orphan cleanup", async (first) => {
    const value = await fixture();
    const repository = createSavedFileRepository(prisma);
    const retention = createPrismaRetentionRepository(prisma);
    let saving!: ReturnType<typeof repository.copy>;
    let pruning!: ReturnType<typeof retention.stageOrphanedAttachments>;
    const save = () => { saving = repository.copy({ attachmentId: value.source.id, save: true, userId: value.user.id }); };
    const prune = () => { pruning = retention.stageOrphanedAttachments({ cutoff, limit: 10 }); };
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${value.source.storageKey}, 260))::text`);
        (first === "save" ? save : prune)();
        await waitForObjectLock(value.source.storageKey, 1);
        (first === "save" ? prune : save)();
        await waitForObjectLock(value.source.storageKey, 2);
      }, { timeout: 25_000 });
      const [saved] = await Promise.all([saving, pruning]);
      if (first === "save") {
        expect(saved).not.toBeNull();
        expect(await prisma.attachment.findUnique({ where: { id: saved!.id } })).toMatchObject({ savedAt: expect.any(Date) });
        expect(await prisma.attachmentDeletionJob.findUnique({ where: { storageKey: value.source.storageKey } })).toBeNull();
      } else {
        expect(saved).toBeNull();
        expect(await prisma.attachment.count({ where: { storageKey: value.source.storageKey } })).toBe(0);
        expect(await prisma.attachmentDeletionJob.findUnique({ where: { storageKey: value.source.storageKey } })).not.toBeNull();
      }
    } finally {
      await Promise.allSettled([saving, pruning]);
      await value.cleanup();
    }
  });
});
