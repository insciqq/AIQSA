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
      documentReasoningEffort: null,
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

  it("passes a bounded independent Documents reasoning override to activation", async () => {
    const service = { activateProfile: vi.fn(), list: vi.fn().mockResolvedValue({}), rollbackProfile: vi.fn() };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never, service: service as never
    });
    const body = { action: "activate_profile", deploymentId: "embedding-1", documentDeploymentId: "reader-1",
      documentReasoningEffort: "low", expectedVersion: 2, pdfProcessingMode: "system_model_vision" };
    const response = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "PATCH"
    }));
    expect(response.status).toBe(200);
    expect(service.activateProfile).toHaveBeenCalledWith({
      deploymentId: "embedding-1", documentDeploymentId: "reader-1", documentReasoningEffort: "low",
      expectedVersion: 2, pdfProcessingMode: "system_model_vision", userId: "user-1"
    });
    for (const fields of [
      { documentReasoningEffort: "" }, { documentReasoningEffort: 1 },
      { documentReasoningEffort: "low\n" }, { documentReasoningEffort: "a".repeat(33) },
      { documentReasoningEffort: "none", pdfProcessingMode: "local", documentDeploymentId: null }
    ]) {
      const invalid = await handlers.PATCH(new Request("http://local.test/api/admin/knowledge", {
        body: JSON.stringify({ ...body, ...fields }), headers: { "content-type": "application/json" }, method: "PATCH"
      }));
      expect(invalid.status).toBe(400);
    }
    expect(service.activateProfile).toHaveBeenCalledOnce();
  });

  it("retries only failed search indexing for an administrator and returns refreshed settings", async () => {
    const service = { list: vi.fn().mockResolvedValue({ operations: {} }), retryFailedSearchProjections: vi.fn().mockResolvedValue(2) };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never, service: service as never
    });
    const response = await handlers.POST(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({ action: "retry_failed_search_projections" }),
      headers: { "content-type": "application/json" }, method: "POST"
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ knowledge: { operations: {} }, retried: 2 });
    expect(service.retryFailedSearchProjections).toHaveBeenCalledOnce();
    expect(service.list.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(service.retryFailedSearchProjections.mock.invocationCallOrder[0]!);
  });

  it("denies the search indexing retry to ordinary users and rejects malformed requests", async () => {
    const service = { list: vi.fn(), retryFailedSearchProjections: vi.fn() };
    const request = (body: unknown, contentType = "application/json") =>
      new Request("http://local.test/api/admin/knowledge", {
        body: JSON.stringify(body), headers: { "content-type": contentType }, method: "POST"
      });
    const user = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session("user")) as never, service: service as never
    });
    expect((await user.POST(request({ action: "retry_failed_search_projections" }))).status).toBe(403);
    const anonymous = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(null) as never, service: service as never
    });
    expect((await anonymous.POST(request({ action: "retry_failed_search_projections" }))).status).toBe(401);
    const admin = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never, service: service as never
    });
    expect((await admin.POST(request({ action: "retry_failed_search_projections" }, "text/plain"))).status).toBe(415);
    for (const body of [{}, { action: "rebuild" }, { action: "retry_failed_search_projections", indexArtifactIds: ["x"] }]) {
      const invalid = await admin.POST(request(body));
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: "knowledge_search_retry_input_invalid" });
    }
    expect(service.retryFailedSearchProjections).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
  });

  it("reports a stable error when the search indexing retry fails", async () => {
    const service = { list: vi.fn(), retryFailedSearchProjections: vi.fn().mockRejectedValue(new Error("PRIVATE_DB")) };
    const handlers = createAdminKnowledgePolicyHandlers({
      resolveAuth: vi.fn().mockResolvedValue(session()) as never, service: service as never
    });
    const response = await handlers.POST(new Request("http://local.test/api/admin/knowledge", {
      body: JSON.stringify({ action: "retry_failed_search_projections" }),
      headers: { "content-type": "application/json" }, method: "POST"
    }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "knowledge_admin_action_failed" });
  });
});
