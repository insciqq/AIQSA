import { describe, expect, it, vi } from "vitest";
import {
  adminProviderErrorMessage,
  createAdminProviderCredential,
  discoverAdminCompatibleModels,
  getAdminProviderConnections,
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
  draftConfig: { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1" },
  draftVersion: 1,
  enabled: false,
  family: "openrouter",
  id: "connection-1",
  models: [],
  unassignedPolicy: "use_default",
  updatedAt: "2026-07-23T00:00:00.000Z"
};

describe("admin provider browser API", () => {
  it("names an assistant-revision deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "assistant_revisions" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("assistant revisions: 1");
  });

  it("names an installation-default deletion blocker in readable administrator feedback", () => {
    expect(adminProviderErrorMessage({
      blockers: [{ count: 1, kind: "installation_default" }],
      code: "provider_delete_conflict",
      resourceIds: []
    })).toContain("installation default: 1");
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
