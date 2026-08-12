import { describe, expect, it, vi } from "vitest";
import { createAdminSystemModelPolicyHandlers } from "./systemModelPolicyHandlers";
import { AdminSystemModelPolicyServiceError } from "./systemModelPolicyService";

function session(role: "admin" | "user" = "admin") {
  return {
    user: { role, status: "active" },
    userId: "user-1"
  };
}

describe("administrator system model policy handlers", () => {
  it("denies non-administrators before reading policy state", async () => {
    const service = { list: vi.fn(), update: vi.fn() };
    const handlers = createAdminSystemModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never,
      service: service as never
    });
    const response = await handlers.GET(new Request(
      "http://local.test/api/admin/providers/system-model-policy"
    ));
    expect(response.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("maps optimistic conflicts and forwards only validated mutation fields", async () => {
    const service = {
      list: vi.fn(),
      update: vi.fn().mockRejectedValue(
        new AdminSystemModelPolicyServiceError("system_model_policy_stale")
      )
    };
    const handlers = createAdminSystemModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/system-model-policy",
      {
        body: JSON.stringify({
          expectedVersion: 2,
          providerModelId: "model-1",
          reasoningEffort: "xhigh"
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "system_model_policy_stale" });
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      userId: "user-1"
    });
  });

  it("returns the refreshed admin projection after clearing", async () => {
    const catalog = {
      candidates: [],
      policy: {
        reasoningEffort: null,
        systemModel: null,
        updatedAt: "2026-08-08T00:00:00.000Z",
        updatedBy: { displayName: "Admin", id: "user-1" },
        version: 3
      }
    };
    const service = {
      list: vi.fn().mockResolvedValue(catalog),
      update: vi.fn().mockResolvedValue(undefined)
    };
    const handlers = createAdminSystemModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/system-model-policy",
      {
        body: JSON.stringify({ expectedVersion: 2, providerModelId: null, reasoningEffort: null }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ systemModelPolicy: catalog });
  });
});
