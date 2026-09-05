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
          rerankerProviderModelId: null,
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
      rerankerProviderModelId: null,
      reasoningEffort: "xhigh",
      userId: "user-1"
    });
  });

  it("returns the refreshed admin projection after clearing", async () => {
    const catalog = {
      candidates: [],
      rerankerCandidates: [],
      policy: {
        reasoningEffort: null,
        rerankerModel: null,
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
        body: JSON.stringify({
          expectedVersion: 2,
          providerModelId: null,
          reasoningEffort: null,
          rerankerProviderModelId: null
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ systemModelPolicy: catalog });
  });

  it("preserves the reranker role when the PATCH field is absent", async () => {
    const service = {
      list: vi.fn().mockResolvedValue({
        candidates: [],
        rerankerCandidates: [],
        policy: {
          reasoningEffort: null,
          rerankerModel: null,
          systemModel: null,
          updatedAt: "2026-08-08T00:00:00.000Z",
          updatedBy: null,
          version: 3
        }
      }),
      update: vi.fn().mockResolvedValue(undefined)
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
          providerModelId: null,
          reasoningEffort: null
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));

    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      providerModelId: null,
      reasoningEffort: null,
      userId: "user-1"
    });
  });

  it("preserves the utility role for a reranker-only PATCH", async () => {
    const service = {
      list: vi.fn().mockResolvedValue({
        candidates: [],
        rerankerCandidates: [],
        policy: {
          reasoningEffort: "xhigh",
          rerankerModel: null,
          systemModel: null,
          updatedAt: "2026-08-08T00:00:00.000Z",
          updatedBy: null,
          version: 3
        }
      }),
      update: vi.fn().mockResolvedValue(undefined)
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
          rerankerProviderModelId: null
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));

    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith({
      expectedVersion: 2,
      rerankerProviderModelId: null,
      userId: "user-1"
    });
  });

  it("rejects a partial utility update and an empty update", async () => {
    const service = { list: vi.fn(), update: vi.fn() };
    const handlers = createAdminSystemModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    for (const body of [
      { expectedVersion: 2, providerModelId: null },
      { expectedVersion: 2 }
    ]) {
      const response = await handlers.PATCH(new Request(
        "http://local.test/api/admin/providers/system-model-policy",
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "PATCH"
        }
      ));
      expect(response.status).toBe(400);
    }
    expect(service.update).not.toHaveBeenCalled();
  });

  it("runs explicit structured-output verification and returns the refreshed projection", async () => {
    const catalog = {
      candidates: [],
      rerankerCandidates: [],
      policy: {
        reasoningEffort: null,
        rerankerModel: null,
        systemModel: null,
        updatedAt: "2026-08-08T00:00:00.000Z",
        updatedBy: null,
        version: 1
      }
    };
    const service = {
      list: vi.fn().mockResolvedValue(catalog),
      update: vi.fn(),
      verifyRole: vi.fn().mockResolvedValue(undefined)
    };
    const handlers = createAdminSystemModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.POST(new Request(
      "http://local.test/api/admin/providers/system-model-policy",
      {
        body: JSON.stringify({ providerModelId: "model-1", role: "memory" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    ));

    expect(response.status).toBe(200);
    expect(service.verifyRole).toHaveBeenCalledWith({
      role: "memory",
      providerModelId: "model-1",
      signal: expect.any(AbortSignal)
    });
    await expect(response.json()).resolves.toEqual({ systemModelPolicy: catalog });
  });

  it("validates verification input and maps provider probe failures", async () => {
    const service = {
      list: vi.fn(),
      update: vi.fn(),
      verifyRole: vi.fn().mockRejectedValue(
        new AdminSystemModelPolicyServiceError("system_model_policy_verification_failed")
      )
    };
    const handlers = createAdminSystemModelPolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const invalid = await handlers.POST(new Request(
      "http://local.test/api/admin/providers/system-model-policy",
      {
        body: JSON.stringify({ extra: true, providerModelId: "model-1" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    ));
    expect(invalid.status).toBe(400);
    expect(service.verifyRole).not.toHaveBeenCalled();

    const failed = await handlers.POST(new Request(
      "http://local.test/api/admin/providers/system-model-policy",
      {
        body: JSON.stringify({ providerModelId: "model-1", role: "memory" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }
    ));
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toEqual({
      error: "system_model_policy_verification_failed"
    });
  });
});
