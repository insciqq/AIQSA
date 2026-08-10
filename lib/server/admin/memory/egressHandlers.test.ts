import { describe, expect, it, vi } from "vitest";
import { AdminMemoryEgressServiceError } from "./egressService";
import { createAdminMemoryEgressHandlers } from "./egressHandlers";

function session(role: "admin" | "user" = "admin") {
  return { user: { role, status: "active" }, userId: "admin-1" };
}

const projection = {
  acceptedAt: null,
  acceptedBy: null,
  acceptedFingerprint: null,
  acceptedPolicyVersion: null,
  consentMode: "ADMIN" as const,
  currentFingerprint: "a".repeat(64),
  currentPolicyVersion: "memory-utility-egress-v1",
  destinations: [],
  reviewRequired: true,
  version: 1,
  waitingJobCount: 0
};

describe("administrator Memory egress handlers", () => {
  it("denies ordinary users before reading installation policy", async () => {
    const service = { acknowledge: vi.fn(), get: vi.fn() };
    const handlers = createAdminMemoryEgressHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never,
      service: service as never
    });

    const response = await handlers.GET(new Request("http://local.test/api/admin/memory"));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(service.get).not.toHaveBeenCalled();
  });

  it("forwards only the exact optimistic acknowledgment and returns private evidence", async () => {
    const service = {
      acknowledge: vi.fn().mockResolvedValue(projection),
      get: vi.fn()
    };
    const handlers = createAdminMemoryEgressHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/memory", {
      body: JSON.stringify({
        currentFingerprint: "a".repeat(64),
        expectedVersion: 3
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(service.acknowledge).toHaveBeenCalledWith("admin-1", {
      currentFingerprint: "a".repeat(64),
      expectedVersion: 3
    });
  });

  it("rejects malformed values and maps a concurrent policy change", async () => {
    const service = {
      acknowledge: vi.fn().mockRejectedValue(
        new AdminMemoryEgressServiceError("memory_admin_egress_policy_changed")
      ),
      get: vi.fn()
    };
    const handlers = createAdminMemoryEgressHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });

    const malformed = await handlers.PATCH(new Request("http://local.test/api/admin/memory", {
      body: JSON.stringify({ currentFingerprint: "a".repeat(64), expectedVersion: "1" }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));
    expect(malformed.status).toBe(400);
    expect(service.acknowledge).not.toHaveBeenCalled();

    const conflict = await handlers.PATCH(new Request("http://local.test/api/admin/memory", {
      body: JSON.stringify({ currentFingerprint: "a".repeat(64), expectedVersion: 1 }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "memory_admin_egress_policy_changed"
    });
  });
});
