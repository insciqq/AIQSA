import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ANNOUNCEMENT_PAGE_SIZE,
  type AnnouncementContent, type AnnouncementCursor, type AnnouncementDetail,
  type AnnouncementPage, type AnnouncementSummary
} from "@/lib/contracts/announcements";
import { announcementExcerpt } from "./excerpt";

const select = { id: true, title: true, body: true, published: true, publishedAt: true,
  createdAt: true, version: true } as const;
type Row = Prisma.AnnouncementGetPayload<{ select: typeof select }>;
type Scope = Readonly<{ userId: string; admin: boolean }>;
export type AnnouncementUpdate = AnnouncementContent & Readonly<{ expectedVersion: number; published: boolean }>;
export class AnnouncementRepositoryError extends Error {
  constructor(readonly code: "announcement_not_found" | "announcement_conflict" | "announcement_delete_published") { super(code); }
}
export type AnnouncementsRepository = Readonly<{
  list(scope: Scope, cursor: AnnouncementCursor | null): Promise<AnnouncementPage>;
  detail(scope: Scope, id: string): Promise<AnnouncementDetail | null>;
  create(content: AnnouncementContent, published?: boolean): Promise<AnnouncementDetail>;
  update(id: string, update: AnnouncementUpdate): Promise<AnnouncementDetail>;
  deleteUnpublished(id: string, expectedVersion: number): Promise<void>;
  markRead(userId: string, id: string | null): Promise<number>;
  unreadCount(userId: string): Promise<number>;
}>;

function summary(row: Row, read: boolean): AnnouncementSummary {
  return { id: row.id, title: row.title, excerpt: announcementExcerpt(row.body),
    createdAt: row.createdAt.toISOString(), publishedAt: row.publishedAt?.toISOString() ?? null,
    published: row.published, read };
}

function unreadWhere(userId: string, createdAt: Date): Prisma.AnnouncementWhereInput {
  return { published: true, publishedAt: { gte: createdAt }, reads: { none: { userId } } };
}

async function countUnread(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
  return tx.announcement.count({ where: unreadWhere(userId, user.createdAt) });
}

type LockedRow = { publishedAt: Date | null; published: boolean; version: number };
async function lockForWrite(tx: Prisma.TransactionClient, id: string, expectedVersion: number): Promise<LockedRow> {
  const [row] = await tx.$queryRaw<LockedRow[]>`
    SELECT "publishedAt", "published", "version" FROM "Announcement" WHERE "id" = ${id} FOR UPDATE`;
  if (!row) throw new AnnouncementRepositoryError("announcement_not_found");
  if (row.version !== expectedVersion) throw new AnnouncementRepositoryError("announcement_conflict");
  return row;
}
function detail(row: Row, read = false): AnnouncementDetail {
  return { ...summary(row, read), body: row.body, version: row.version };
}

export function createAnnouncementsRepository(db: PrismaClient): AnnouncementsRepository {
  return {
    async list({ userId, admin }, cursor) {
      const sort = admin ? "createdAt" : "publishedAt";
      const where: Prisma.AnnouncementWhereInput = {
        ...(!admin ? { published: true } : {}),
        ...(cursor ? { OR: [
          { [sort]: { lt: new Date(cursor.at) } },
          { [sort]: new Date(cursor.at), id: { lt: cursor.id } }
        ] } : {})
      };
      const { rows, unreadCount, createdAt } = await db.$transaction(async tx => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
        const rows = await tx.announcement.findMany({ where, select: { ...select, reads: { where: { userId }, select: { userId: true } } },
          orderBy: [{ [sort]: "desc" }, { id: "desc" }], take: ANNOUNCEMENT_PAGE_SIZE + 1 });
        const unreadCount = await tx.announcement.count({ where: unreadWhere(userId, user.createdAt) });
        return { rows, unreadCount, createdAt: user.createdAt };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      const page = rows.slice(0, ANNOUNCEMENT_PAGE_SIZE);
      const last = page.at(-1);
      return { items: page.map((row) => summary(row, row.reads.length > 0 || !!row.publishedAt && row.publishedAt < createdAt)), unreadCount,
        nextCursor: rows.length > ANNOUNCEMENT_PAGE_SIZE && last ? `${last[sort]!.toISOString()}|${last.id}` : null };
    },
    async detail({ userId, admin }, id) {
      return db.$transaction(async tx => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
        const row = await tx.announcement.findFirst({ where: { id, ...(!admin ? { published: true } : {}) },
          select: { ...select, reads: { where: { userId }, select: { userId: true } } } });
        return row ? detail(row, row.reads.length > 0 || !!row.publishedAt && row.publishedAt < user.createdAt) : null;
      });
    },
    async create(content, published = false) {
      return detail(await db.announcement.create({ data: { ...content, published, publishedAt: published ? new Date() : null }, select }));
    },
    async update(id, { expectedVersion, published, ...content }) {
      return db.$transaction(async (tx) => {
        // Serialize competing admin edits and preserve the first publication identity.
        const row = await lockForWrite(tx, id, expectedVersion);
        return detail(await tx.announcement.update({ where: { id }, select,
          data: { ...content, published, publishedAt: row.publishedAt ?? (published ? new Date() : null), version: { increment: 1 } } }));
      });
    },
    async deleteUnpublished(id, version) {
      await db.$transaction(async tx => {
        const row = await lockForWrite(tx, id, version);
        if (row.published) throw new AnnouncementRepositoryError("announcement_delete_published");
        await tx.announcement.delete({ where: { id } });
      });
    },
    async markRead(userId, id) {
      // One statement captures the published set. A later publication remains unread.
      return db.$transaction(async tx => {
        const [result] = await tx.$queryRaw<{ found: boolean }[]>`
          WITH published AS (
            SELECT "id" FROM "Announcement" WHERE "published" = true
            ${id === null ? Prisma.empty : Prisma.sql`AND "id" = ${id}`}
          ), marked AS (
            INSERT INTO "AnnouncementRead" ("userId", "announcementId")
            SELECT ${userId}, "id" FROM published
            ON CONFLICT ("userId", "announcementId") DO NOTHING
          ) SELECT EXISTS (SELECT 1 FROM published) AS found`;
        if (id !== null && !result?.found) throw new AnnouncementRepositoryError("announcement_not_found");
        return countUnread(tx, userId);
      });
    },
    async unreadCount(userId) {
      return db.$transaction(tx => countUnread(tx, userId));
    }
  };
}
