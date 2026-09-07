import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { AuthenticatedSession, RequestAuthResolver } from "../../auth/requestAuth";
import {
  createAdminProviderCatalogHandler,
  createAdminProviderConnectionActionHandler,
  createAdminProviderConnectionCreateHandler,
  createAdminProviderCredentialCreateHandler,
  createAdminProviderCredentialUpdateHandler,
  createAdminProviderDraftTestHandler
} from "./handlers";
import {
  AdminProviderServiceError,
  type AdminProviderService
} from "./service";

const connection: AdminProviderConnection = {
  activatedAt: null,
  activeChecks: [],
  activeConfig: null,
  activeVersion: 0,
  assignments: [],
  createdAt: "2026-07-23T00:00:00.000Z",
  credentials: [{
    activatedAt: null,
    activeVersion: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    draftSecretConfigured: true,
    draftVersion: 1,
    enabled: true,
    id: "credential-1",
    label: "Primary",
    testedAt: null,
    updatedAt: "2026-07-23T00:00:00.000Z"
  }],
  defaultCredentialId: "credential-1",
  displayName: "OpenRouter",
  draftChecks: [],
  draftConfig: {
    allowPrivateNetwork: false,
    apiRoot: "https://openrouter.example.test/api/v1",
    authenticationMode: "bearer",
    responseTimeoutSeconds: 300
  },
  draftVersion: 1,
  enabled: false,
  family: "openrouter",
  id: "connection-1",
  models: [{
    activatedAt: null,
    activeConfig: null,
    activeVersion: 0,
    connectionId: "connection-1",
    createdAt: "2026-07-23T00:00:00.000Z",
    displayName: "Model",
    draftConfig: {
      adapterKind: "openrouter_chat_completions",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      defaultParams: {},
      modelClass: "answer",
      openRouterRouting: { mode: "automatic", providers: [] },
      upstreamModelId: "vendor/model"
    },
    draftVersion: 1,
    enabled: true,
    id: "model-1",
    updatedAt: "2026-07-23T00:00:00.000Z"
  }],
  unassignedPolicy: "use_default",
  updatedAt: "2026-07-23T00:00:00.000Z",
  userAssignments: []
};

function auth(role = "admin", status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Admin",
      email: "admin@example.test",
      id: "admin-1",
      role,
      status
    },
    userId: "admin-1"
  };
}

function resolver(value: AuthenticatedSession | null): RequestAuthResolver {
  return async () => value;
}

function service(overrides: Partial<Record<keyof AdminProviderService, unknown>> = {}) {
  return {
    activateConnection: vi.fn(),
    activateNewCredential: vi.fn(),
    activateRotatedCredential: vi.fn(),
    assignGroupCredential: vi.fn(),
    clearCredentialDraft: vi.fn(),
    createConnectionDraft: vi.fn(),
    createModelDraft: vi.fn(),
    deleteConnection: vi.fn(),
    deleteCredential: vi.fn(),
    deleteModel: vi.fn(),
    disable: vi.fn(),
    discoverCompatibleModels: vi.fn(),
    discoverOpenRouterEndpoints: vi.fn(),
    discoverOpenRouterModels: vi.fn(),
    enable: vi.fn(),
    listConnections: vi.fn(async () => [connection]),
    refreshActive: vi.fn(),
    renameCredential: vi.fn(),
    revokeCredentialVersion: vi.fn(),
    revokeGroupCredential: vi.fn(),
    rotateCredential: vi.fn(),
    setDefaultCredential: vi.fn(),
    testDraft: vi.fn(),
    updateConnectionDraft: vi.fn(),
    updateModelDraft: vi.fn(),
    ...overrides
  } as unknown as AdminProviderService;
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method
  });
}

describe("admin provider HTTP handlers", () => {
  it("allows only active administrators and rejects non-JSON mutations", async () => {
    const providerService = service();
    const anonymous = createAdminProviderCatalogHandler({
      resolveAuth: resolver(null),
      service: providerService
    });
    expect((await anonymous(new Request("http://localhost/api/admin/providers"))).status).toBe(401);

    const ordinary = createAdminProviderConnectionCreateHandler({
      resolveAuth: resolver(auth("user")),
      service: providerService
    });
    expect((await ordinary(jsonRequest("http://localhost/api/admin/providers", {}))).status).toBe(403);

    const admin = createAdminProviderConnectionCreateHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    expect((await admin(new Request("http://localhost/api/admin/providers", {
      body: "{}",
      method: "POST"
    }))).status).toBe(415);
    expect(providerService.createConnectionDraft).not.toHaveBeenCalled();
  });

  it("saves a write-only key in one step and never returns its plaintext", async () => {
    const activateNewCredential = vi.fn(async () => ({
      credentialId: "credential-1",
      versionId: "version-1"
    }));
    const providerService = service({ activateNewCredential });
    const handler = createAdminProviderCredentialCreateHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    const request = jsonRequest("http://localhost/api/admin/providers/connection-1/credentials", {
      activate: true,
      label: "Primary",
      secret: "never-return-this-key"
    });
    const response = await handler(request, { params: { connectionId: "connection-1" } });
    const body = await response.text();
    expect(response.status).toBe(201);
    expect(activateNewCredential).toHaveBeenCalledWith({
      connectionId: "connection-1",
      label: "Primary",
      secret: "never-return-this-key",
      signal: request.signal
    });
    expect(body).not.toContain("never-return-this-key");
    expect(body).not.toContain("secretEnvelope");
    expect(JSON.parse(body)).toEqual({ connections: [connection] });

    const draftOnly = await handler(
      jsonRequest("http://localhost/api/admin/providers/connection-1/credentials", {
        label: "Primary",
        secret: "never-return-this-key"
      }),
      { params: { connectionId: "connection-1" } }
    );
    expect(draftOnly.status).toBe(400);
    expect(activateNewCredential).toHaveBeenCalledOnce();
  });

  it("maps a rejected key to 422 without a catalog and a duplicate label to 409", async () => {
    const providerService = service({
      activateNewCredential: vi.fn(async () => {
        throw new AdminProviderServiceError("provider_credential_test_failed");
      })
    });
    const handler = createAdminProviderCredentialCreateHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    const rejected = await handler(
      jsonRequest("http://localhost/api/admin/providers/connection-1/credentials", {
        activate: true,
        label: "Primary",
        secret: "rejected-key"
      }),
      { params: { connectionId: "connection-1" } }
    );
    expect(rejected.status).toBe(422);
    const rejectedBody = await rejected.text();
    expect(JSON.parse(rejectedBody)).toEqual({ error: "provider_credential_test_failed" });
    expect(rejectedBody).not.toContain("rejected-key");

    const taken = await createAdminProviderCredentialCreateHandler({
      resolveAuth: resolver(auth()),
      service: service({
        activateNewCredential: vi.fn(async () => {
          throw new AdminProviderServiceError("provider_credential_label_taken");
        })
      })
    })(
      jsonRequest("http://localhost/api/admin/providers/connection-1/credentials", {
        activate: true,
        label: "Primary",
        secret: "another-key"
      }),
      { params: { connectionId: "connection-1" } }
    );
    expect(taken.status).toBe(409);
  });

  it("rotates a key in one step only with an explicit activate flag", async () => {
    const activateRotatedCredential = vi.fn(async () => ({
      credentialId: "credential-1",
      versionId: "version-2"
    }));
    const rotateCredential = vi.fn(async () => ({ draftVersion: 2 }));
    const providerService = service({ activateRotatedCredential, rotateCredential });
    const handler = createAdminProviderCredentialUpdateHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    const context = { params: { connectionId: "connection-1", credentialId: "credential-1" } };
    const request = jsonRequest("http://localhost/api/admin/providers/connection-1/credentials/credential-1", {
      action: "rotate",
      activate: true,
      expectedDraftVersion: 1,
      secret: "rotated-key"
    }, "PATCH");
    const response = await handler(request, context);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("rotated-key");
    expect(activateRotatedCredential).toHaveBeenCalledWith({
      connectionId: "connection-1",
      credentialId: "credential-1",
      expectedDraftVersion: 1,
      secret: "rotated-key",
      signal: request.signal
    });
    expect(rotateCredential).not.toHaveBeenCalled();

    const draft = await handler(
      jsonRequest("http://localhost/api/admin/providers/connection-1/credentials/credential-1", {
        action: "rotate",
        expectedDraftVersion: 1,
        secret: "rotated-key"
      }, "PATCH"),
      context
    );
    expect(draft.status).toBe(200);
    expect(rotateCredential).toHaveBeenCalledWith({
      credentialId: "credential-1",
      expectedDraftVersion: 1,
      secret: "rotated-key"
    });
    expect(activateRotatedCredential).toHaveBeenCalledOnce();

    const unknown = await handler(
      jsonRequest("http://localhost/api/admin/providers/connection-1/credentials/credential-9", {
        action: "rotate",
        activate: true,
        expectedDraftVersion: 1,
        secret: "rotated-key"
      }, "PATCH"),
      { params: { connectionId: "connection-1", credentialId: "credential-9" } }
    );
    expect(unknown.status).toBe(404);
  });

  it("exposes account-filtered discovery without accepting a browser key", async () => {
    const discoverOpenRouterModels = vi.fn(async () => [{
      id: "vendor/model",
      inputModalities: ["text"],
      name: "Model",
      outputModalities: ["text"],
      pricing: {},
      supportedParameters: []
    }]);
    const providerService = service({ discoverOpenRouterModels });
    const handler = createAdminProviderConnectionActionHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    const request = jsonRequest("http://localhost/api/admin/providers/connection-1/actions", {
      action: "discover_models",
      credentialId: "credential-1"
    });
    const response = await handler(request, { params: { connectionId: "connection-1" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [expect.objectContaining({ id: "vendor/model" })] });
    expect(discoverOpenRouterModels).toHaveBeenCalledWith({
      connectionId: "connection-1",
      credentialId: "credential-1",
      signal: request.signal
    });
  });

  it("exposes only compatible model ids and bounded capabilities from the selected stored credential", async () => {
    const discoverCompatibleModels = vi.fn(async () => [
      { capabilities: { reasoning: true, reasoningEfforts: ["low", "high"] }, id: "vendor/model-a" },
      { capabilities: {}, id: "vendor/model-b" }
    ]);
    const handler = createAdminProviderConnectionActionHandler({
      resolveAuth: resolver(auth()),
      service: service({ discoverCompatibleModels })
    });
    const request = jsonRequest("http://localhost/api/admin/providers/connection-1/actions", {
      action: "discover_compatible_models",
      credentialId: "credential-1"
    });

    const response = await handler(request, { params: { connectionId: "connection-1" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: [
        { capabilities: { reasoning: true, reasoningEfforts: ["low", "high"] }, id: "vendor/model-a" },
        { capabilities: {}, id: "vendor/model-b" }
      ]
    });
    expect(discoverCompatibleModels).toHaveBeenCalledWith({
      connectionId: "connection-1",
      credentialId: "credential-1",
      signal: request.signal
    });
  });

  it("runs an exact model/credential check and maps stale evidence safely", async () => {
    const testDraft = vi.fn(async () => ({
      checkedAt: "2026-07-23T00:00:00.000Z",
      connectionDraftVersion: 1,
      credentialDraftVersion: 1,
      credentialId: "credential-1",
      credentialVersionId: null,
      evidence: {
        detail: "ok" as const,
        method: "openrouter_account_catalog" as const,
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      fingerprint: "safe-fingerprint",
      modelDraftVersion: 1,
      providerModelId: "model-1",
      status: "available" as const
    }));
    const providerService = service({ testDraft });
    const handler = createAdminProviderDraftTestHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    const response = await handler(
      jsonRequest("http://localhost/test", {
        credentialId: "credential-1",
        mode: "account_catalog"
      }),
      { params: { connectionId: "connection-1", modelId: "model-1" } }
    );
    expect(response.status).toBe(200);
    expect(testDraft).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "connection-1",
      credentialId: "credential-1",
      providerModelId: "model-1"
    }));

    testDraft.mockRejectedValueOnce(new AdminProviderServiceError("provider_draft_stale"));
    const stale = await handler(
      jsonRequest("http://localhost/test", {
        credentialId: "credential-1",
        mode: "account_catalog"
      }),
      { params: { connectionId: "connection-1", modelId: "model-1" } }
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "provider_draft_stale" });
  });

  it("runs explicit active refresh and returns a value-free transient failure", async () => {
    const refreshActive = vi.fn(async () => {
      throw new AdminProviderServiceError("provider_refresh_failed");
    });
    const providerService = service({ refreshActive });
    const handler = createAdminProviderConnectionActionHandler({
      resolveAuth: resolver(auth()),
      service: providerService
    });
    const request = jsonRequest("http://localhost/api/admin/providers/connection-1/actions", {
      action: "refresh_active",
      confirmPaidRequest: false,
      credentialId: "credential-1",
      providerModelId: "model-1"
    });
    const response = await handler(request, { params: { connectionId: "connection-1" } });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_refresh_failed" });
    expect(refreshActive).toHaveBeenCalledWith({
      confirmPaidRequest: false,
      connectionId: "connection-1",
      credentialId: "credential-1",
      providerModelId: "model-1",
      signal: request.signal
    });
  });
});
