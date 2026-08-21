import { describe, expect, it, vi } from "vitest";
import type { AdminMemoryStatus } from "../../../contracts/adminMemory";
import { AdminMemoryStatusServiceError } from "./statusService";
import { createAdminMemoryStatusHandlers } from "./statusHandlers";

const status: AdminMemoryStatus = {
  admissionTimeout: { seconds: 15, version: 4 },
  activeIssueCode: null,
  configuredTargets: [{ model: "Utility", provider: "Primary" }],
  index: { generation: 2, readiness: "READY" },
  queue: { length: 0, oldestAgeSeconds: null },
  rebuild: { state: "NOT_REQUIRED" },
  worker: { state: "RUNNING" }
};

function auth(role: "admin" | "user" = "admin") {
  return vi.fn().mockResolvedValue({
    user: { role, status: "active" },
    userId: "admin-1"
  });
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue(status),
    rebuild: vi.fn().mockResolvedValue({
      ...status,
      index: { generation: 2, readiness: "REBUILDING" },
      queue: { length: 1, oldestAgeSeconds: 0 },
      rebuild: { state: "IN_PROGRESS" }
    }),
    updateAdmissionTimeout: vi.fn().mockResolvedValue({
      ...status,
      admissionTimeout: { seconds: 30, version: 5 }
    }),
    ...overrides
  };
}

describe("administrator Memory status handlers", () => {
  it("returns only the minimal private status to an active administrator", async () => {
    const handler = createAdminMemoryStatusHandlers({
      resolveAuth: auth(),
      service: service()
    });
    const response = await handler.GET(new Request("http://local.test/api/admin/memory"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ memory: status });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps anonymous and non-admin callers outside the status boundary", async () => {
    const anonymous = createAdminMemoryStatusHandlers({
      resolveAuth: vi.fn().mockResolvedValue(null),
      service: service()
    });
    expect((await anonymous.GET(new Request("http://local.test"))).status).toBe(401);
    const nonAdmin = createAdminMemoryStatusHandlers({
      resolveAuth: auth("user"),
      service: service()
    });
    expect((await nonAdmin.GET(new Request("http://local.test"))).status).toBe(403);
  });

  it("admits the one strict rebuild action without target identifiers", async () => {
    const memoryService = service();
    const handler = createAdminMemoryStatusHandlers({
      resolveAuth: auth(),
      service: memoryService
    });
    const invalid = await handler.POST(new Request("http://local.test", {
      body: JSON.stringify({ action: "REBUILD_REQUIRED", userId: "private" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(invalid.status).toBe(400);
    const accepted = await handler.POST(new Request("http://local.test", {
      body: JSON.stringify({ action: "REBUILD_REQUIRED" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(accepted.status).toBe(202);
    expect(memoryService.rebuild).toHaveBeenCalledOnce();
  });

  it("returns a stable conflict when a bounded rebuild cannot be admitted", async () => {
    const handler = createAdminMemoryStatusHandlers({
      resolveAuth: auth(),
      service: service({
        rebuild: vi.fn().mockRejectedValue(
          new AdminMemoryStatusServiceError("memory_admin_rebuild_unavailable")
        )
      })
    });
    const response = await handler.POST(new Request("http://local.test", {
      body: JSON.stringify({ action: "REBUILD_REQUIRED" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "memory_admin_rebuild_unavailable"
    });
  });

  it("updates the installation timeout through a strict admin-only payload", async () => {
    const memoryService = service();
    const handler = createAdminMemoryStatusHandlers({
      resolveAuth: auth(),
      service: memoryService
    });
    const response = await handler.PUT(new Request("http://local.test", {
      body: JSON.stringify({ expectedVersion: 4, timeoutSeconds: 30 }),
      headers: { "content-type": "application/json" },
      method: "PUT"
    }));

    expect(response.status).toBe(200);
    expect(memoryService.updateAdmissionTimeout).toHaveBeenCalledWith({
      expectedVersion: 4,
      seconds: 30,
      userId: "admin-1"
    });
    await expect(response.json()).resolves.toMatchObject({
      memory: { admissionTimeout: { seconds: 30, version: 5 } }
    });
  });
});
