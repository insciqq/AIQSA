import { describe, expect, it, vi } from "vitest";
import { createAdminAttentionHandler } from "./handlers";

const attention = {
  checkedAt: "2026-09-07T12:00:00.000Z",
  items: [],
  unavailable: []
};

function auth(role: "admin" | "user" = "admin", status = "active") {
  return vi.fn().mockResolvedValue({ user: { role, status }, userId: "admin-1" });
}

describe("admin attention handler", () => {
  it("returns the aggregated list to an active administrator without caching", async () => {
    const list = vi.fn().mockResolvedValue(attention);
    const GET = createAdminAttentionHandler({ resolveAuth: auth(), service: { list } });
    const response = await GET(new Request("http://local.test/api/admin/attention"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ attention });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(list).toHaveBeenCalledWith("admin-1");
  });

  it("rejects anonymous, non-admin and inactive callers", async () => {
    const list = vi.fn().mockResolvedValue(attention);
    const anonymous = createAdminAttentionHandler({ resolveAuth: vi.fn().mockResolvedValue(null), service: { list } });
    expect((await anonymous(new Request("http://local.test"))).status).toBe(401);
    const user = createAdminAttentionHandler({ resolveAuth: auth("user"), service: { list } });
    expect((await user(new Request("http://local.test"))).status).toBe(403);
    const disabled = createAdminAttentionHandler({ resolveAuth: auth("admin", "disabled"), service: { list } });
    expect((await disabled(new Request("http://local.test"))).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it("reports an aggregation failure as a stable code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const GET = createAdminAttentionHandler({
      resolveAuth: auth(),
      service: { list: vi.fn().mockRejectedValue(new Error("boom")) }
    });
    const response = await GET(new Request("http://local.test"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "admin_attention_failed" });
  });
});
