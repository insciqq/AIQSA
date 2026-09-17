// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createAnnouncementsRepository } from "./repository";
import { decodeAnnouncementContent, decodeAnnouncementCursor, type AnnouncementDetail } from "@/lib/contracts/announcements";

const repository = createAnnouncementsRepository(prisma);
const users: string[] = [], announcements: string[] = [];
const content = { title: "Synthetic announcement", body: "# News\nA **plain** excerpt." };
async function owner(createdAt = new Date("2026-01-01T00:00:00.000Z")) {
  const id = `announcement-test-${randomUUID()}`;
  await prisma.user.create({ data: { id, status: "active", displayName: "Synthetic reader", createdAt } });
  users.push(id); return id;
}
async function create(published = false) {
  const entry = await repository.create(content, published); announcements.push(entry.id); return entry;
}
async function update(entry: AnnouncementDetail, published: boolean, body = entry.body) {
  return repository.update(entry.id, { title: entry.title, body, published, expectedVersion: entry.version });
}
afterEach(async () => {
  await prisma.announcement.deleteMany({ where: { id: { in: announcements.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted announcements", () => {
  it("preserves first publication and account-isolated receipts through edits and withdrawal", async () => {
    const a = await owner(), b = await owner();
    const draft = await create();
    expect(await repository.detail({ userId: a, admin: false }, draft.id)).toBeNull();
    expect(await repository.unreadCount(a)).toBe(0);
    let entry = await update(draft, true);
    const publishedAt = entry.publishedAt;
    expect(publishedAt).not.toBeNull();
    expect(await repository.markRead(a, entry.id)).toBe(0);
    expect(await repository.unreadCount(b)).toBe(1);
    entry = await update(entry, true, "Edited text");
    expect(entry.publishedAt).toBe(publishedAt);
    entry = await update(entry, false);
    expect(await repository.detail({ userId: b, admin: false }, entry.id)).toBeNull();
    await expect(repository.markRead(b, entry.id)).rejects.toThrow("announcement_not_found");
    expect(await prisma.announcementRead.count({ where: { announcementId: entry.id } })).toBe(1);
    entry = await update(entry, true);
    expect(entry.publishedAt).toBe(publishedAt);
    expect(await repository.unreadCount(a)).toBe(0);
    expect(await repository.unreadCount(b)).toBe(1);
    expect((await repository.detail({ userId: a, admin: false }, entry.id))?.read).toBe(true);
  });

  it("lets new accounts read history but marks only publications at or after creation unread", async () => {
    const createdAt = new Date("2026-08-01T12:00:00.000Z");
    const userId = await owner(createdAt);
    const older = await create(), sameTime = await create();
    for (const [entry, at] of [[older, new Date(createdAt.getTime() - 1)], [sameTime, createdAt]] as const) {
      await prisma.announcement.update({ where: { id: entry.id }, data: { published: true, publishedAt: at } });
    }
    const page = await repository.list({ userId, admin: false }, null);
    expect(page.items).toHaveLength(2);
    expect(page.items.find(item => item.id === older.id)?.read).toBe(true);
    expect(page.items.find(item => item.id === sameTime.id)?.read).toBe(false);
    expect((await repository.detail({ userId, admin: false }, older.id))?.read).toBe(true);
    expect(page.unreadCount).toBe(1);
    expect(await repository.unreadCount(userId)).toBe(1);
    expect(await prisma.announcementRead.count({ where: { userId } })).toBe(0);
  });

  it("serializes competing writes, classifies deletion, and cascades receipts only after withdrawal", async () => {
    const userId = await owner();
    let entry = await create(true);
    const outcomes = await Promise.allSettled([update(entry, true, "First"), update(entry, true, "Second")]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "announcement_conflict" } });
    entry = (await repository.detail({ userId, admin: true }, entry.id))!;
    await repository.markRead(userId, entry.id);
    await expect(repository.deleteUnpublished(entry.id, entry.version)).rejects.toThrow("announcement_delete_published");
    entry = await update(entry, false);
    await expect(repository.deleteUnpublished(entry.id, entry.version - 1)).rejects.toThrow("announcement_conflict");
    await repository.deleteUnpublished(entry.id, entry.version);
    expect(await prisma.announcementRead.count({ where: { announcementId: entry.id } })).toBe(0);
    expect(await prisma.announcement.findUnique({ where: { id: entry.id } })).toBeNull();
    await expect(repository.deleteUnpublished(entry.id, entry.version)).rejects.toThrow("announcement_not_found");
  });

  it("marks a server snapshot while a publication committing afterwards remains unread", async () => {
    const userId = await owner();
    const before = await create(true), after = await create();
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const publication = prisma.$transaction(async tx => {
      await tx.announcement.update({ where: { id: after.id }, data: { published: true, publishedAt: new Date() } });
      ready(); await proceed;
    });
    try {
      await started;
      expect(await repository.markRead(userId, null)).toBe(0);
    } finally { release(); await publication; }
    expect(await repository.unreadCount(userId)).toBe(1);
    const receipts = await prisma.announcementRead.findMany({ where: { userId }, select: { announcementId: true } });
    expect(receipts).toEqual([{ announcementId: before.id }]);
  });

  it("paginates equal-time publications without duplicates and hides all drafts", async () => {
    const userId = await owner();
    const publishedAt = new Date();
    for (let index = 0; index < 43; index++) {
      const id = randomUUID(); announcements.push(id);
      await prisma.announcement.create({ data: { id, ...content, published: index < 41, publishedAt: index < 41 ? publishedAt : null } });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repository.list({ userId, admin: false }, decodeAnnouncementCursor(cursor));
      expect(page.items.length).toBeLessThanOrEqual(20);
      expect(page.items.every(item => item.excerpt === "News A plain excerpt.")).toBe(true);
      ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(41);
    expect(new Set(ids).size).toBe(41);
  });

  it.each([
    { title: "🙂".repeat(80), body: "Ж".repeat(20_000) },
    { title: "\t Title \n", body: "\n**Markdown**\n" },
    { title: "x".repeat(160), body: "🙂".repeat(10_000) }
  ])("stores decoder-accepted boundary content without hitting database checks", async input => {
    const accepted = decodeAnnouncementContent(input);
    expect(accepted).not.toBeNull();
    const entry = await repository.create(accepted!); announcements.push(entry.id);
    expect(entry.title).toBe(accepted!.title);
    expect(entry.body).toBe(accepted!.body);
  });
});
