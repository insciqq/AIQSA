import { describe, expect, it, vi } from "vitest";
import {
  adminProviderErrorMessage,
  createAdminProviderCredential,
  discoverAdminCompatibleModels,
  getAdminProviderConnections,
  runAdminProviderConnectionAction,
  testAdminProviderCredential
} from "./adminProvidersApi";

const safeConnection = {
  activatedAt: null,
  activeChecks: [],
  activeConfig: null,
  activeVersion: 0,
  assignments: [],
  createdAt: "2026-07-23T00:00:00.000Z",
  credentials: [{
    activeVersion: null,
    draftSecretConfigured: true,
    draftVersion: 1,
    enabled: true,
    id: "credential-1",
    label: "Primary"
  }],
  defaultCredentialId: null,
  displayName: "OpenRouter",
  draftChecks: [],
  draftConfig: {
    allowPrivateNetwork: false,
    apiRoot: "https://openrouter.ai/api/v1",
    authenticationMode: "bearer",
    responseTimeoutSeconds: 300
  },
  draftVersion: 1,
  enabled: false,
  family: "openrouter",
  id: "connection-1",
  models: [],
  unassignedPolicy: "use_default",
  updatedAt: "2026-07-23T00:00:00.000Z",
  userAssignments: []
};

describe("admin provider browser API", () => {
  it("accepts a model that inherits its response timeout from the connection", async () => {
    const fetcher = vi.fn(async () => Response.json({
      connections: [{
        ...safeConnection,
        models: [{
          displayName: "Inherited timeout model",
          draftConfig: {
            adapterKind: "openai_responses_compatible",
            answerSelectable: true,
            modelClass: "answer",
            upstreamModelId: "fixture/inherited-timeout"
          },
          draftVersion: 1,
          enabled: true,
          id: "model-inherited-timeout"
        }]
      }]
    }));

    await expect(getAdminProviderConnections(fetcher)).resolves.toMatchObject({
      data: [{ models: [{ id: "model-inherited-timeout" }] }],
      ok: true
    });
  });

  it("names an Assistant deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "assistants" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("assistants: 1");
  });

  it("names an installation-default deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "installation_default" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("installation default: 1");
  });

  it("names a utility-model deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "system_model" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("utility model role: 1");
  });

  it("sends credentials only in same-origin JSON mutation bodies", async () => {
    const fetcher = vi.fn(async () => Response.json({ connections: [safeConnection] }));
    await expect(createAdminProviderCredential(
      "connection/one",
      { label: "Primary", secret: "write-only-key" },
      fetcher
    )).resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/providers/connection%2Fone/credentials",
      expect.objectContaining({
        body: JSON.stringify({ label: "Primary", secret: "write-only-key" }),
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
  });

  it("fails closed if a catalog response contains secret material", async () => {
    const fetcher = vi.fn(async () => Response.json({
      connections: [{
        ...safeConnection,
        credentials: [{
          ...safeConnection.credentials[0],
          secretEnvelope: "must-not-reach-browser-state"
        }]
      }]
    }));
    const result = await getAdminProviderConnections(fetcher);
    expect(result).toEqual({
      error: { blockers: [], code: "provider_admin_response_invalid", resourceIds: [] },
      ok: false
    });
  });

  it("identifies a missing provider action route instead of showing a generic provider error", async () => {
    const result = await runAdminProviderConnectionAction(
      "connection-1",
      { action: "refresh_active" },
      vi.fn(async () => new Response("<!doctype html><title>Not Found</title>", {
        headers: { "content-type": "text/html" },
        status: 404
      }))
    );

    expect(result).toEqual({
      error: { blockers: [], code: "provider_admin_route_unavailable", resourceIds: [] },
      ok: false
    });
    if (!result.ok) {
      expect(adminProviderErrorMessage(result.error)).toContain("Restart the development app");
    }
  });

  it("decodes only bounded safe credential-test metadata", async () => {
    const fetcher = vi.fn(async () => Response.json({
      test: {
        checkedAt: "2026-07-24T00:00:00.000Z",
        connectionDraftVersion: 2,
        modelCount: 12,
        status: "valid"
      }
    }));
    await expect(testAdminProviderCredential(
      "connection/one",
      { expectedConnectionDraftVersion: 2, secret: "write-only-key" },
      fetcher
    )).resolves.toEqual({
      data: {
        checkedAt: "2026-07-24T00:00:00.000Z",
        connectionDraftVersion: 2,
        modelCount: 12,
        status: "valid"
      },
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/providers/connection%2Fone/credential-tests",
      expect.objectContaining({
        body: JSON.stringify({ expectedConnectionDraftVersion: 2, secret: "write-only-key" }),
        credentials: "same-origin",
        method: "POST"
      })
    );
  });

  it("decodes compatible discovery as bounded capability rows and rejects secret material", async () => {
    const fetcher = vi.fn(async () => Response.json({
      models: [
        {
          capabilities: {
            defaultReasoningEffort: "medium",
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"]
          },
          id: "vendor/model-a"
        },
        { capabilities: {}, id: "vendor/model-b" }
      ]
    }));
    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      fetcher
    )).resolves.toEqual({
      data: [
        {
          capabilities: {
            defaultReasoningEffort: "medium",
            reasoning: true,
            reasoningEfforts: ["low", "medium", "high"]
          },
          id: "vendor/model-a"
        },
        { capabilities: {}, id: "vendor/model-b" }
      ],
      ok: true
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/admin/providers/connection%2Fone/actions",
      expect.objectContaining({
        body: JSON.stringify({
          action: "discover_compatible_models",
          credentialId: "credential/one"
        }),
        method: "POST"
      })
    );

    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      vi.fn(async () => Response.json({
        models: [{ capabilities: {}, id: "vendor/model-a", secret: "must-not-enter-state" }]
      }))
    )).resolves.toMatchObject({
      error: { code: "provider_admin_response_invalid" },
      ok: false
    });

    await expect(discoverAdminCompatibleModels(
      "connection/one",
      "credential/one",
      vi.fn(async () => Response.json({
        models: [{
          capabilities: {
            reasoning: false,
            reasoningEfforts: ["low", "low"]
          },
          id: "vendor/model-a"
        }]
      }))
    )).resolves.toMatchObject({
      error: { code: "provider_admin_response_invalid" },
      ok: false
    });
  });
});
