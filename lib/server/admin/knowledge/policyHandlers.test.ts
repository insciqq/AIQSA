import { describe, expect, it, vi } from "vitest";
import { AdminKnowledgeProfileServiceError } from "./profileService";
import { createAdminKnowledgePolicyHandlers } from "./policyHandlers";

function session(role: "admin" | "user" = "admin") {
  return { user: { role, status: "active" }, userId: "user-1" };
}

describe("administrator Knowledge settings handlers", () => {
  it("denies ordinary users before settings are read", async () => {
    const service = { list: vi.fn() };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never,
      service: service as never
    });
    const response = await handlers.GET(new Request("http://local.test/api/admin/knowledge"));

    expect(response.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects the removed mutable retrieval policy payload", async () => {
    const service = {
      activateProfile: vi.fn(),
      list: vi.fn(),
      rollbackProfile: vi.fn()
    };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({
        candidateLimit: 20,
        expectedVersion: 3,
        resultLimit: 4,
        scoreThreshold: 0.15
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_profile_input_invalid" });
    expect(service.activateProfile).not.toHaveBeenCalled();
    expect(service.rollbackProfile).not.toHaveBeenCalled();
  });

  it("admits only an embedding profile activation and maps conflicts", async () => {
    const service = {
      activateProfile: vi.fn().mockRejectedValue(
        new AdminKnowledgeProfileServiceError("knowledge_profile_destination_unavailable")
      ),
      list: vi.fn(),
      rollbackProfile: vi.fn()
    };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({
        action: "activate_profile",
        deploymentId: "embedding-1",
        expectedVersion: 2
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(409);
    expect(service.activateProfile).toHaveBeenCalledWith({
      deploymentId: "embedding-1",
      expectedVersion: 2,
      userId: "user-1"
    });

    const obsoleteVisionResponse = await handlers.PATCH(new Request(
      "http://local.test/api/admin/knowledge",
      {
        body: JSON.stringify({
          action: "activate_profile",
          deploymentId: "embedding-1",
          expectedVersion: 2,
          visionDeploymentId: "vision-1"
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }
    ));
    expect(obsoleteVisionResponse.status).toBe(400);
    expect(service.activateProfile).toHaveBeenCalledTimes(1);
  });
});
