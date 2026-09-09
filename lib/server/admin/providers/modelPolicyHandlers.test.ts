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
  it.each([undefined, 4, "", " high", "high\u0000", "x".repeat(33)])(
    "rejects malformed reasoning before mutation: %j", async (reasoningEffort) => {
      const service = { list: vi.fn(), update: vi.fn() };
      const handlers = createAdminModelPolicyHandlers({
        resolveAuth: vi.fn().mockResolvedValue(session()) as never, service: service as never
      });
      const response = await handlers.PATCH(new Request("http://local.test/api/admin/providers/model-policy", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: 1, providerModelId: "model-1", reasoningEffort })
      }));
      expect(response.status).toBe(400);
      expect(service.update).not.toHaveBeenCalled();
    }
  );

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
        body: JSON.stringify({ expectedVersion: 2, providerModelId: "model-1", reasoningEffort: null }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "model_policy_stale" });
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      providerModelId: "model-1",
      reasoningEffort: null,
      userId: "user-1"
    });
  });

  it("accepts uncapped positive safe tool budgets and rejects invalid values", async () => {
    const service = {
      list: vi.fn().mockResolvedValue({}),
      update: vi.fn()
    };
    const handlers = createAdminModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const accepted = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/model-policy",
      {
        body: JSON.stringify({
          expectedVersion: 2,
          mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
          maxMcpToolsPerDiscovery: 10,
          maxToolCalls: 200,
          maxToolRounds: 200
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(accepted.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 200,
      userId: "user-1"
    });

    for (const body of [
      { maxToolCalls: 0, maxToolRounds: 8, maxMcpToolsPerDiscovery: 10, mcpAutoDiscoveryTimeoutSeconds: 60 },
      { maxToolCalls: 4, maxToolRounds: 8 },
      { expectedVersion: 2 },
      { maxToolCalls: 4, maxToolRounds: 8, maxMcpToolsPerDiscovery: 10, mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192, extra: 1 }
    ]) {
      const rejected = await handlers.PATCH(new Request(
        "http://local.test/api/admin/providers/model-policy",
        {
          body: JSON.stringify({ expectedVersion: 2, ...body }),
          headers: { "content-type": "application/json" },
          method: "PATCH"
        }
      ));
      expect(rejected.status).toBe(400);
    }
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it.each([1024, 32768, 65536, 1023, 65537, 4096.5, "8192", null])("validates the MCP output allowance %s before dispatch", async (tokens) => {
    const service = { list: vi.fn().mockResolvedValue({}), update: vi.fn() };
    const handlers = createAdminModelPolicyHandlers({ resolveAuth: vi.fn().mockResolvedValue(session()) as never, service: service as never });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/providers/model-policy", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({
        expectedVersion: 2, maxToolCalls: 20, maxToolRounds: 8, maxMcpToolsPerDiscovery: 10,
        mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: tokens
      })
    }));
    const valid = typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 1024 && tokens <= 65536;
    expect(response.status).toBe(valid ? 200 : 400);
    expect(service.update).toHaveBeenCalledTimes(valid ? 1 : 0);
    if (valid) expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ mcpAutoDiscoveryMaxOutputTokens: tokens }));
  });

  it("forwards the default model and tool limits as one validated update", async () => {
    const service = { list: vi.fn().mockResolvedValue({}), update: vi.fn() };
    const handlers = createAdminModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request(
      "http://local.test/api/admin/providers/model-policy",
      {
        body: JSON.stringify({
          expectedVersion: 3,
          maxMcpToolsPerDiscovery: 12,
          maxToolCalls: 24,
          maxToolRounds: 8,
          mcpAutoDiscoveryTimeoutSeconds: 20, mcpAutoDiscoveryMaxOutputTokens: 8192,
          providerModelId: "model-1",
          reasoningEffort: "medium"
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 3,
      maxMcpToolsPerDiscovery: 12,
      maxToolCalls: 24,
      maxToolRounds: 8,
      mcpAutoDiscoveryTimeoutSeconds: 20, mcpAutoDiscoveryMaxOutputTokens: 8192,
      providerModelId: "model-1",
      reasoningEffort: "medium",
      userId: "user-1"
    });
  });
});
