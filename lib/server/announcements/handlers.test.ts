import { describe, expect, it, vi } from "vitest";
import { createAnnouncementsHandlers } from "./handlers";
import { AnnouncementRepositoryError, type AnnouncementsRepository } from "./repository";

const entry = { id: "announcement-1", title: "Update", body: "The message", excerpt: "The message", published: true,
  publishedAt: "2026-09-16T12:00:00.000Z", createdAt: "2026-09-15T12:00:00.000Z", read: false, version: 3 };
function fixture() {
  const repository = {
    list: vi.fn().mockResolvedValue({ items: [entry], nextCursor: null, unreadCount: 1 }),
    detail: vi.fn().mockResolvedValue(entry), create: vi.fn().mockResolvedValue(entry), update: vi.fn().mockResolvedValue(entry),
    deleteUnpublished: vi.fn().mockResolvedValue(undefined), markRead: vi.fn().mockResolvedValue(0), unreadCount: vi.fn().mockResolvedValue(1)
  } satisfies AnnouncementsRepository;
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "reader", user: { id: "reader", status: "active", role: "user" } });
  return { repository, resolveAuth, handle: createAnnouncementsHandlers({ repository, resolveAuth }) };
}
const request = (body?: unknown, query = "") => new Request(`http://localhost/api/announcements${query}`, body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

describe("announcements operation boundary", () => {
  it.each([null, { status: "pending", role: "user" }, { status: "disabled", role: "admin" }])("rejects an inactive identity before repository work: %s", async user => {
    const f = fixture();
    f.resolveAuth.mockResolvedValue(user ? { userId: "reader", user } : null);
    const response = await f.handle(request(), "list");
    expect(response.status).toBe(user ? 403 : 401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.repository.list).not.toHaveBeenCalled();
  });

  it.each(["list", "detail", "create", "update", "delete"] as const)("requires administrator authority for admin %s", async action => {
    const f = fixture();
    expect((await f.handle(request(), action, true, entry.id)).status).toBe(403);
    for (const method of Object.values(f.repository)) expect(method).not.toHaveBeenCalled();
  });

  it("returns explicit user projections without administrative metadata", async () => {
    const f = fixture();
    // A repository may retain internal columns; the user boundary must not spread them.
    f.repository.detail.mockResolvedValueOnce({ ...entry, privateAuditId: "private" });
    const response = await f.handle(request(), "detail", false, entry.id);
    expect(await response.json()).toEqual({ id: entry.id, title: entry.title, body: entry.body,
      excerpt: entry.excerpt, publishedAt: entry.publishedAt, read: false });
    // Normal repository summaries have no body/version. Exercise the same explicit projection.
    expect(await (await f.handle(request(), "list")).json()).toEqual({ items: [{ id: entry.id, title: entry.title,
      excerpt: entry.excerpt, publishedAt: entry.publishedAt, read: false }], nextCursor: null, unreadCount: 1 });
  });

  it.each([null, { ...entry, published: false }])("does not distinguish missing and hidden details: %s", async value => {
    const f = fixture(); f.repository.detail.mockResolvedValueOnce(value);
    const response = await f.handle(request(), "detail", false, entry.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "announcement_not_found" });
  });

  it.each([
    { title: "", body: "Text" }, { title: "a\nb", body: "Text" }, { title: "Title", body: "\0" },
    { title: "x".repeat(161), body: "Text" }, { title: "Title", body: "x".repeat(20_001) },
    { title: "Title", body: "Text", extra: true }
  ])("rejects invalid content before database work", async value => {
    const f = fixture(); f.resolveAuth.mockResolvedValue({ userId: "admin", user: { role: "admin", status: "active" } });
    expect((await f.handle(request(value), "create", true)).status).toBe(400);
    expect(f.repository.create).not.toHaveBeenCalled();
  });

  it("rejects invalid cursors and uses a lightweight count read", async () => {
    const f = fixture();
    expect((await f.handle(request(undefined, "?cursor=invalid"), "list")).status).toBe(400);
    expect(f.repository.list).not.toHaveBeenCalled();
    expect(await (await f.handle(request(), "count")).json()).toEqual({ unreadCount: 1 });
    expect(f.repository.unreadCount).toHaveBeenCalledWith("reader");
    expect(f.repository.list).not.toHaveBeenCalled();
  });

  it("uses owner-scoped read mutations and returns the authoritative count", async () => {
    const f = fixture();
    expect(await (await f.handle(request({ id: entry.id }), "read")).json()).toEqual({ unreadCount: 0 });
    expect(f.repository.markRead).toHaveBeenLastCalledWith("reader", entry.id);
    await f.handle(request({ id: null }), "read");
    expect(f.repository.markRead).toHaveBeenLastCalledWith("reader", null);
  });

  it.each([
    ["announcement_not_found", 404], ["announcement_conflict", 409], ["announcement_delete_published", 409]
  ] as const)("classifies %s without leaking database details", async (code, status) => {
    const f = fixture(); f.resolveAuth.mockResolvedValue({ userId: "admin", user: { role: "admin", status: "active" } });
    f.repository.deleteUnpublished.mockRejectedValueOnce(new AnnouncementRepositoryError(code));
    const response = await f.handle(request({ expectedVersion: 3 }), "delete", true, entry.id);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("sanitizes unexpected errors in both the response and logs", async () => {
    const f = fixture(); f.repository.list.mockRejectedValueOnce(new Error("private SQL body"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await f.handle(request(), "list");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "announcements_unavailable" });
      expect(log).toHaveBeenCalledWith("announcements_action_failed");
    } finally { log.mockRestore(); }
  });
});
