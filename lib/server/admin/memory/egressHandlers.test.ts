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

const health = {
  admin: vi.fn().mockResolvedValue({
    deletion: { active: "NONE", blocked: "NONE", state: "CLEAR" },
    observedAt: "2026-08-12T10:00:00.000Z",
    overall: "HEALTHY",
    provider: {
      failedRecent: "NONE",
      outcomeUnknown: "NONE",
      state: "IDLE",
      usageIncomplete: "NONE"
    },
    queue: {
      active: "NONE",
      failed: "NONE",
      oldestLag: "NONE",
      state: "CLEAR",
      waitingForReview: "NONE"
    },
    requestLocale: "EN",
    scheduler: { resetAt: "2026-08-13T00:00:00.000Z", state: "READY" },
    temporary: { overdue: "NONE", state: "CLEAR" }
  }),
  user: vi.fn()
};

describe("administrator Memory egress handlers", () => {
  it("denies ordinary users before reading installation policy", async () => {
    const service = { acknowledge: vi.fn(), get: vi.fn() };
    const handlers = createAdminMemoryEgressHandlers({
      healthService: health as never,
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
      healthService: health as never,
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
    expect(health.admin).toHaveBeenCalledWith("admin-1", {
      egressReviewRequired: true
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
      healthService: health as never,
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

  it("keeps destination reads usable with a private-safe unavailable health projection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createAdminMemoryEgressHandlers({
      healthService: {
        admin: vi.fn().mockRejectedValue(new Error("private health detail")),
        user: vi.fn()
      } as never,
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: {
        acknowledge: vi.fn(),
        get: vi.fn().mockResolvedValue(projection)
      } as never
    });

    const response = await handlers.GET(new Request("http://local.test/api/admin/memory"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      memoryEgress: projection,
      memoryHealth: {
        overall: "UNAVAILABLE",
        queue: { active: "UNKNOWN", state: "UNKNOWN" }
      }
    });
    expect(error).toHaveBeenCalledWith("memory_admin_health_read_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("private health detail");
  });
});
