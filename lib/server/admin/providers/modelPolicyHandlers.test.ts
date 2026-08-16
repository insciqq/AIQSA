import { describe, expect, it, vi } from "vitest";
import { AdminModelPolicyServiceError } from "./modelPolicyService";
import { createAdminModelPolicyHandlers } from "./modelPolicyHandlers";

function session(role: "admin" | "user" = "admin") {
  return {
    user: { role, status: "active" },
    userId: "user-1"
  };
}

describe("administrator model policy handlers", () => {
  it("denies non-administrators before reading policy state", async () => {
    const service = { list: vi.fn(), update: vi.fn() };
    const handlers = createAdminModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never,
      service: service as never
    });
    const response = await handlers.GET(new Request("http://local.test/api/admin/providers/model-policy"));
    expect(response.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("maps optimistic conflicts and forwards only validated mutation fields", async () => {
    const service = {
      list: vi.fn(),
      update: vi.fn().mockRejectedValue(new AdminModelPolicyServiceError("model_policy_stale"))
    };
    const handlers = createAdminModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/model-policy",
      {
        body: JSON.stringify({ expectedVersion: 2, providerModelId: "model-1" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "model_policy_stale" });
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      providerModelId: "model-1",
      userId: "user-1"
    });
  });

  it("accepts uncapped positive safe tool budgets and rejects invalid values", async () => {
    const service = {
      list: vi.fn().mockResolvedValue({}),
      update: vi.fn(),
      updateToolBudgets: vi.fn()
    };
    const handlers = createAdminModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const accepted = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/model-policy",
      {
        body: JSON.stringify({ expectedVersion: 2, maxToolCalls: 200, maxToolRounds: 200 }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(accepted.status).toBe(200);
    expect(service.updateToolBudgets).toHaveBeenCalledWith({
      expectedVersion: 2,
      maxToolCalls: 200,
      maxToolRounds: 200,
      userId: "user-1"
    });

    const rejected = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/model-policy",
      {
        body: JSON.stringify({ expectedVersion: 2, maxToolCalls: 0, maxToolRounds: 8 }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(rejected.status).toBe(400);
  });
});
