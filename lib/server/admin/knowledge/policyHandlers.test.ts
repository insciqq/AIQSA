import { describe, expect, it, vi } from "vitest";
import { AdminKnowledgePolicyServiceError } from "./policyService";
import { AdminKnowledgeProfileServiceError } from "./profileService";
import { createAdminKnowledgePolicyHandlers } from "./policyHandlers";

function session(role: "admin" | "user" = "admin") {
  return { user: { role, status: "active" }, userId: "user-1" };
}

describe("administrator Knowledge policy handlers", () => {
  it("denies ordinary users before policy state is read", async () => {
    const service = { list: vi.fn(), update: vi.fn() };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never,
      service: service as never
    });
    const response = await handlers.GET(new Request("http://local.test/api/admin/knowledge"));
    expect(response.status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("forwards only a validated bounded update and maps optimistic conflicts", async () => {
    const service = {
      list: vi.fn(),
      update: vi.fn().mockRejectedValue(
        new AdminKnowledgePolicyServiceError("knowledge_policy_stale")
      )
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

    expect(response.status).toBe(409);
    expect(service.update).toHaveBeenCalledWith({
      candidateLimit: 20,
      expectedVersion: 3,
      resultLimit: 4,
      scoreThreshold: 0.15,
      userId: "user-1"
    });
  });

  it("rejects coercible and inconsistent values before mutation", async () => {
    const service = { list: vi.fn(), update: vi.fn() };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    for (const body of [
      { candidateLimit: "20", expectedVersion: 1, resultLimit: 4, scoreThreshold: 0.1 },
      { candidateLimit: 2, expectedVersion: 1, resultLimit: 4, scoreThreshold: 0.1 }
    ]) {
      const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));
      expect(response.status).toBe(400);
    }
    expect(service.update).not.toHaveBeenCalled();
  });

  it("admits profile activation only as a strict administrator action", async () => {
    const service = {
      activateProfile: vi.fn().mockRejectedValue(
        new AdminKnowledgeProfileServiceError("knowledge_profile_destination_unavailable")
      ),
      list: vi.fn(),
      update: vi.fn()
    };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({
        action: "activate_profile",
        deploymentId: "embedding-1",
        expectedVersion: 2,
        visionDeploymentId: null
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(409);
    expect(service.activateProfile).toHaveBeenCalledWith({
      deploymentId: "embedding-1",
      expectedVersion: 2,
      userId: "user-1",
      visionDeploymentId: null
    });
  });
});
