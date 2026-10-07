import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createAdminAttentionHandler, createAdminAttentionSummaryHandler } from "./handlers";

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
    const observation = await captureRunObservation();
    const GET = createAdminAttentionHandler({
      resolveAuth: auth(),
      service: { list: vi.fn().mockRejectedValue(new Error("PRIVATE boom")) }
    });
    const response = await GET(new Request("http://local.test"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "admin_attention_failed" });
    expect(observation.records()).toContainEqual(expect.objectContaining({ event: "service_operation", subsystem: "admin",
      stage: "read", outcome: "failed", code: "admin_attention_failed" }));
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE");
  });
});

describe("admin attention summary handler", () => {
  const summary = { bad: 1, checkedAt: "2026-10-07T12:00:00.000Z", health: 1, unavailable: [], warn: 0 };

  it("returns the badge counts to an active administrator without HTTP caching", async () => {
    const read = vi.fn().mockResolvedValue(summary);
    const GET = createAdminAttentionSummaryHandler({ resolveAuth: auth(), service: { read } });
    const response = await GET(new Request("http://local.test/api/admin/attention/summary"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ summary });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects anonymous, non-admin and inactive callers before reading anything", async () => {
    const read = vi.fn().mockResolvedValue(summary);
    const anonymous = createAdminAttentionSummaryHandler({ resolveAuth: vi.fn().mockResolvedValue(null), service: { read } });
    expect((await anonymous(new Request("http://local.test"))).status).toBe(401);
    const user = createAdminAttentionSummaryHandler({ resolveAuth: auth("user"), service: { read } });
    const forbidden = await user(new Request("http://local.test"));
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "forbidden" });
    const disabled = createAdminAttentionSummaryHandler({ resolveAuth: auth("admin", "disabled"), service: { read } });
    expect((await disabled(new Request("http://local.test"))).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("reports a failed read as a stable code without its message", async () => {
    const observation = await captureRunObservation();
    const GET = createAdminAttentionSummaryHandler({
      resolveAuth: auth(),
      service: { read: vi.fn().mockRejectedValue(new Error("PRIVATE boom")) }
    });
    const response = await GET(new Request("http://local.test"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "admin_attention_failed" });
    expect(JSON.stringify(observation.records())).not.toContain("PRIVATE");
  });
});
