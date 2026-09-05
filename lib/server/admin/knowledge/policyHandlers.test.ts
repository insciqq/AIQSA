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

  it("updates the maximum Knowledge search budget with optimistic versioning", async () => {
    const service = {
      activateProfile: vi.fn(),
      list: vi.fn().mockResolvedValue({ answerPolicy: { maximumKnowledgeSearches: 18 } }),
      rollbackProfile: vi.fn(),
      updateAnswerPolicy: vi.fn()
    };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({
        action: "update_answer_policy",
        expectedVersion: 4,
        maximumKnowledgeSearches: 18
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(200);
    expect(service.updateAnswerPolicy).toHaveBeenCalledWith({
      expectedVersion: 4,
      maximumKnowledgeSearches: 18,
      userId: "user-1"
    });
    await expect(response.json()).resolves.toEqual({
      knowledge: { answerPolicy: { maximumKnowledgeSearches: 18 } }
    });
  });

  it("updates the ingestion parallelism with optimistic versioning", async () => {
    const service = {
      activateProfile: vi.fn(),
      list: vi.fn().mockResolvedValue({ answerPolicy: { ingestionParallelism: 64 } }),
      rollbackProfile: vi.fn(),
      updateIngestionParallelism: vi.fn()
    };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({
        action: "update_ingestion_parallelism",
        expectedVersion: 3,
        ingestionParallelism: 64
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(200);
    expect(service.updateIngestionParallelism).toHaveBeenCalledWith({
      expectedVersion: 3,
      ingestionParallelism: 64,
      userId: "user-1"
    });
    await expect(response.json()).resolves.toEqual({
      knowledge: { answerPolicy: { ingestionParallelism: 64 } }
    });
  });

  it("rejects an out-of-bounds or malformed ingestion parallelism before the service", async () => {
    const service = {
      activateProfile: vi.fn(),
      list: vi.fn(),
      rollbackProfile: vi.fn(),
      updateIngestionParallelism: vi.fn()
    };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never,
      service: service as never
    });
    for (const body of [
      { action: "update_ingestion_parallelism", expectedVersion: 1, ingestionParallelism: 0 },
      { action: "update_ingestion_parallelism", expectedVersion: 1, ingestionParallelism: 65 },
      { action: "update_ingestion_parallelism", expectedVersion: 1, ingestionParallelism: 2.5 },
      { action: "update_ingestion_parallelism", expectedVersion: 0, ingestionParallelism: 4 },
      {
        action: "update_ingestion_parallelism",
        expectedVersion: 1,
        ingestionParallelism: 4,
        maximumKnowledgeSearches: 12
      }
    ]) {
      const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "knowledge_ingestion_parallelism_invalid"
      });
    }
    expect(service.updateIngestionParallelism).not.toHaveBeenCalled();
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
        expectedVersion: 2,
        documentDeploymentId: null,
        pdfProcessingMode: "local"
      }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    }));

    expect(response.status).toBe(409);
    expect(service.activateProfile).toHaveBeenCalledWith({
      deploymentId: "embedding-1",
      expectedVersion: 2,
      documentDeploymentId: null,
      pdfProcessingMode: "local",
      userId: "user-1"
    });

    const obsoleteVisionResponse = await handlers.PATCH(new Request(
      "http://local.test/api/admin/knowledge",
      {
        body: JSON.stringify({
          action: "activate_profile",
          deploymentId: "embedding-1",
          expectedVersion: 2,
          documentDeploymentId: null,
          pdfProcessingMode: "local",
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
