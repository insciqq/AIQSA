import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import type { AdminHealthQueuesService } from "./queues";
import { createAdminHealthQueuesHandler } from "./queuesHandler";

const snapshot = { checkedAt: "2026-10-07T12:00:00.000Z", queues: [] };

function service(read = vi.fn().mockResolvedValue(snapshot)): AdminHealthQueuesService {
  return { read, stalled: vi.fn() };
}

const request = new Request("http://local.test/api/admin/health/queues");

describe("admin health queues handler", () => {
  it("serves the snapshot to an active administrator without caching", async () => {
    const response = await createAdminHealthQueuesHandler({
      resolveAuth: vi.fn().mockResolvedValue({ user: { role: "admin", status: "active" }, userId: "admin-1" }),
      service: service()
    })(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ queues: snapshot });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects anonymous, non-admin and inactive callers before reading any queue", async () => {
    const read = vi.fn();
    for (const [session, status] of [
      [null, 401],
      [{ user: { role: "user", status: "active" }, userId: "u" }, 403],
      [{ user: { role: "admin", status: "disabled" }, userId: "a" }, 403]
    ] as const) {
      const response = await createAdminHealthQueuesHandler({ resolveAuth: vi.fn().mockResolvedValue(session), service: service(read) })(request);
      expect(response.status).toBe(status);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("answers a failed read with a stable error and a content-free log record", async () => {
    const observation = await captureRunObservation();
    const response = await createAdminHealthQueuesHandler({
      resolveAuth: vi.fn().mockResolvedValue({ user: { role: "admin", status: "active" }, userId: "admin-1" }),
      service: service(vi.fn().mockRejectedValue(new Error("connection refused at db.internal")))
    })(request);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "admin_health_failed" });
    expect(observation.records()).toContainEqual(expect.objectContaining({ event: "service_operation", code: "admin_health_failed" }));
    expect(JSON.stringify(observation.records())).not.toContain("db.internal");
  });
});
