import { describe, expect, it, vi } from "vitest";
import type { AdminProviderConnection } from "../../../contracts/adminProviders";
import type { AuthenticatedSession, RequestAuthResolver } from "../../auth/requestAuth";
import {
  createAdminProviderCatalogHandler,
  createAdminProviderCheckRunHandler,
  createAdminProviderConnectionActionHandler,
  createAdminProviderConnectionCreateHandler,
  createAdminProviderConnectionUpdateHandler,
  createAdminProviderCredentialCreateHandler,
  createAdminProviderCredentialUpdateHandler,
  createAdminProviderModelCreateHandler,
  createAdminProviderModelUpdateHandler
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
    activateModel: vi.fn(async () => ({ check: "checked" })),
    activateNewCredential: vi.fn(),
    activateRotatedCredential: vi.fn(),
    assignGroupCredential: vi.fn(),
    cancelCheckRun: vi.fn(),
    checkRun: vi.fn(),
    createConnectionDraft: vi.fn(),
    createModelDraft: vi.fn(async () => ({ id: "model-new", displayName: "Sonnet", draftVersion: 1 })),
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
    renameModel: vi.fn(),
    revokeCredentialVersion: vi.fn(),
    revokeGroupCredential: vi.fn(),
    saveConnectionSettings: vi.fn(),
    setDefaultCredential: vi.fn(),
    startCheckRun: vi.fn(),
    updateModelDraft: vi.fn(async () => ({ displayName: "Sonnet", draftVersion: 2 })),
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
      userId: "admin-1",
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
    const providerService = service({ activateRotatedCredential });
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
      userId: "admin-1",
      connectionId: "connection-1",
      credentialId: "credential-1",
      expectedDraftVersion: 1,
      secret: "rotated-key",
      signal: request.signal
    });

    const draft = await handler(
      jsonRequest("http://localhost/api/admin/providers/connection-1/credentials/credential-1", {
        action: "rotate",
        expectedDraftVersion: 1,
        secret: "rotated-key"
      }, "PATCH"),
      context
    );
    expect(draft.status).toBe(400);
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

  it("saves and checks a model in one request only with an explicit activate flag", async () => {
    const providerService = service();
    const create = createAdminProviderModelCreateHandler({ resolveAuth: resolver(auth()), service: providerService });
    const body = { configuration: connection.models[0]!.draftConfig, displayName: "Sonnet" };
    const draftOnly = await create(
      jsonRequest("http://localhost/models", body),
      { params: { connectionId: "connection-1" } }
    );
    expect(draftOnly.status).toBe(201);
    expect(providerService.activateModel).not.toHaveBeenCalled();

    const checked = await create(
      jsonRequest("http://localhost/models", { ...body, activate: true }),
      { params: { connectionId: "connection-1" } }
    );
    expect(checked.status).toBe(201);
    expect(providerService.createModelDraft).toHaveBeenCalledTimes(2);
    expect(providerService.activateModel).toHaveBeenCalledWith({ connectionId: "connection-1", modelId: "model-new", expectedDraftVersion: 1,
      signal: expect.any(AbortSignal), onProgress: undefined, onActivated: expect.any(Function) });
    expect((await create(
      jsonRequest("http://localhost/models", { ...body, activate: "yes" }),
      { params: { connectionId: "connection-1" } }
    )).status).toBe(400);

    const update = createAdminProviderModelUpdateHandler({ resolveAuth: resolver(auth()), service: providerService });
    const updated = await update(
      jsonRequest("http://localhost/models/model-1", { ...body, action: "update", activate: true,
        expectedActiveVersion: 1, expectedDisplayName: "Sonnet", expectedDraftVersion: 1, expectedUpdatedAt: connection.updatedAt }, "PATCH"),
      { params: { connectionId: "connection-1", modelId: "model-1" } }
    );
    expect(updated.status).toBe(200);
    expect(providerService.updateModelDraft).toHaveBeenCalledWith(expect.objectContaining({ expectedDraftVersion: 1, modelId: "model-1" }));
    expect(providerService.activateModel).toHaveBeenLastCalledWith({ connectionId: "connection-1", modelId: "model-1", expectedDraftVersion: 2,
      signal: expect.any(AbortSignal), onProgress: undefined, onActivated: expect.any(Function) });
  });

  it("starts, reads and cancels background checks without exposing anything but progress", async () => {
    const run = {
      credentialId: "credential-1",
      current: "model-1",
      done: 0,
      failed: [],
      finishedAt: null,
      id: "run-1",
      inFlight: ["model-1"],
      reason: "requested" as const,
      startedAt: "2026-09-07T12:51:00.000Z",
      state: "running" as const,
      total: 1
    };
    const providerService = service({
      cancelCheckRun: vi.fn(() => ({ ...run, state: "cancelled" })),
      checkRun: vi.fn(() => run),
      startCheckRun: vi.fn(async () => run)
    });
    const actions = createAdminProviderConnectionActionHandler({ resolveAuth: resolver(auth()), service: providerService });
    const started = await actions(
      jsonRequest("http://localhost/actions", { action: "check_models", credentialId: "credential-1", modelIds: ["model-1"] }),
      { params: { connectionId: "connection-1" } }
    );
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ connections: expect.any(Array) });
    expect(providerService.startCheckRun).toHaveBeenCalledWith({
      userId: "admin-1",
      connectionId: "connection-1",
      credentialId: "credential-1",
      modelIds: ["model-1"],
      reason: "requested"
    });
    expect((await actions(
      jsonRequest("http://localhost/actions", { action: "check_models", credentialId: "credential-1", modelIds: "model-1" }),
      { params: { connectionId: "connection-1" } }
    )).status).toBe(400);

    const cancelled = await actions(
      jsonRequest("http://localhost/actions", { action: "cancel_check", runId: "run-1" }),
      { params: { connectionId: "connection-1" } }
    );
    expect(cancelled.status).toBe(200);
    expect(providerService.cancelCheckRun).toHaveBeenCalledWith({ connectionId: "connection-1", runId: "run-1" });

    const progress = createAdminProviderCheckRunHandler({ resolveAuth: resolver(auth()), service: providerService });
    const read = await progress(
      new Request("http://localhost/api/admin/providers/connection-1/actions?run=run-1"),
      { params: { connectionId: "connection-1" } }
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ run });
    expect((await progress(
      new Request("http://localhost/api/admin/providers/connection-1/actions"),
      { params: { connectionId: "connection-1" } }
    )).status).toBe(400);
    expect((await progress(
      new Request("http://localhost/api/admin/providers/connection-2/actions?run=run-1"),
      { params: { connectionId: "connection-2" } }
    )).status).toBe(404);
    expect((await createAdminProviderCheckRunHandler({ resolveAuth: resolver(null), service: providerService })(
      new Request("http://localhost/api/admin/providers/connection-1/actions?run=run-1"),
      { params: { connectionId: "connection-1" } }
    )).status).toBe(401);
  });
});

describe("provider settings Test & Save boundary", () => {
  it("uses one atomic settings action, enforces admin auth and keeps keys out of responses", async () => {
    const providerService = service();
    const handler = createAdminProviderConnectionUpdateHandler({ resolveAuth: resolver(auth()), service: providerService });
    const body = {
      activate: true, configuration: connection.draftConfig, credentialSecrets: [{ credentialId: "credential-1", secret: "replacement-private-value" }],
      displayName: "New name", expectedDraftVersion: 1, unassignedPolicy: "use_default"
    };
    const url = "http://localhost/api/admin/providers/connection-1";
    const response = await handler(jsonRequest(url, body, "PATCH"), { params: { connectionId: "connection-1" } });
    expect(response.status).toBe(200);
    expect(providerService.saveConnectionSettings).toHaveBeenCalledWith(expect.objectContaining({ credentialSecrets: body.credentialSecrets }));
    expect(await response.text()).not.toContain("replacement-private-value");
    const unauthenticated = createAdminProviderConnectionUpdateHandler({ resolveAuth: resolver(null), service: providerService });
    expect((await unauthenticated(jsonRequest(url, body, "PATCH"), { params: { connectionId: "connection-1" } })).status).toBe(401);
    expect((await handler(jsonRequest(url, { ...body, credentialSecrets: [{ credentialId: "credential-1" }] }, "PATCH"), { params: { connectionId: "connection-1" } })).status).toBe(400);
    expect((await handler(jsonRequest(url, { ...body, activate: undefined }, "PATCH"), { params: { connectionId: "connection-1" } })).status).toBe(400);
    expect(providerService.saveConnectionSettings).toHaveBeenCalledTimes(1);
  });
});
