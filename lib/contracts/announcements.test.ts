import { describe, expect, it } from "vitest";
import { decodeAnnouncementContent, decodeAnnouncementCursor, decodeAnnouncementUnreadCount, decodeUserAnnouncementDetail, decodeUserAnnouncementPage } from "./announcements";

const item = { id: "announcement-1", title: "News", excerpt: "A message", publishedAt: "2026-09-16T12:00:00.000Z", read: false };
describe("announcements public contract", () => {
  it("accepts only the minimal published user projection", () => {
    const value = { ...item, body: "A message" };
    expect(decodeUserAnnouncementDetail(value)).toEqual(value);
    for (const extra of [{ version: 1 }, { createdAt: item.publishedAt }, { userId: "someone" }, { published: true }]) {
      expect(decodeUserAnnouncementDetail({ ...value, ...extra })).toBeNull();
    }
    expect(decodeUserAnnouncementDetail({ ...value, publishedAt: null })).toBeNull();
    expect(decodeUserAnnouncementDetail({ ...value, publishedAt: "2026-02-30T12:00:00.000Z" })).toBeNull();
  });
  it("bounds list metadata and dedicated count responses", () => {
    const page = { items: [item], nextCursor: null, unreadCount: 1 };
    expect(decodeUserAnnouncementPage(page)).toEqual(page);
    expect(decodeUserAnnouncementPage({ ...page, items: Array(21).fill(item) })).toBeNull();
    expect(decodeUserAnnouncementPage({ ...page, extra: true })).toBeNull();
    expect(decodeUserAnnouncementPage({ ...page, items: [{ ...item, excerpt: "x".repeat(181) }] })).toBeNull();
    expect(decodeAnnouncementUnreadCount({ unreadCount: 0 })).toBe(0);
    expect(decodeAnnouncementUnreadCount({ unreadCount: -1 })).toBeNull();
    expect(decodeAnnouncementUnreadCount({ unreadCount: 0, items: [] })).toBeNull();
    expect(decodeAnnouncementCursor(`${item.publishedAt}|${item.id}`)).toEqual({ at: item.publishedAt, id: item.id });
    expect(decodeAnnouncementCursor(`${item.publishedAt}|${item.id}|extra`)).toBeNull();
  });
  it.each(["\0", "\ud800", "\udc00", " \t\n", "x".repeat(20_001)])("rejects non-storable or empty content", body => {
    expect(decodeAnnouncementContent({ title: "Title", body })).toBeNull();
  });
  it("normalizes outer whitespace while preserving Unicode and literal Markdown", () => {
    expect(decodeAnnouncementContent({ title: "  Новости 🙂  ", body: "\n**Добро пожаловать** 🙂\n" }))
      .toEqual({ title: "Новости 🙂", body: "**Добро пожаловать** 🙂" });
  });
});
