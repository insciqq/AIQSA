import { describe, expect, it, vi } from "vitest";
import {
  createAdminProviderQuickSetupMutationHandler,
  createAdminProviderQuickSetupSnapshotHandler
} from "./quickSetupHandlers";
import { ProviderConfigurationError } from "../../providers/providerConfiguration";
import {
  AdminProviderQuickSetupServiceError,
  type AdminProviderQuickSetupService
} from "./quickSetupService";

const session = {
  expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  id: "session-admin",
  user: {
    displayName: "Admin",
    email: "admin@example.test",
    id: "admin",
    role: "admin",
    status: "active"
  },
  userId: "admin"
};

function service(overrides: Partial<AdminProviderQuickSetupService> = {}): AdminProviderQuickSetupService {
  return {
    getSnapshot: vi.fn(async () => ({
      providers: []
    })),
    setup: vi.fn(async () => ({
      checkedAt: "2026-07-26T10:00:00.000Z",
      connectionId: "00000000-0000-4000-8000-000000001102",
      defaultCredentialChanged: true,
      defaultChanged: true,
      model: { displayName: "GPT-5.6 Terra" },
      models: [
        { displayName: "GPT-5.6 Terra" },
        { displayName: "GPT-5.6 Luna" },
        { displayName: "GPT-5.6 Sol" }
      ],
      outcome: "ready" as const,
      provider: "openai" as const,
      providerDisplayName: "OpenAI"
    })),
    ...overrides
  };
}

describe("provider Quick setup handlers", () => {
  it("requires an active administrator for GET and POST", async () => {
    const deps = { resolveAuth: vi.fn(async () => null), service: service() };
    const getResponse = await createAdminProviderQuickSetupSnapshotHandler(deps)(
      new Request("http://localhost/api/admin/providers/quick-setup")
    );
    const postResponse = await createAdminProviderQuickSetupMutationHandler(deps)(
      new Request("http://localhost/api/admin/providers/quick-setup", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
  });

  it.each([
    ["active ordinary user", { role: "user", status: "active" }],
    ["inactive administrator", { role: "admin", status: "disabled" }]
  ] as const)("rejects an %s for GET and POST", async (_label, userState) => {
    const deniedSession = {
      ...session,
      user: { ...session.user, ...userState }
    };
    const deniedService = service();
    const deps = {
      resolveAuth: vi.fn(async () => deniedSession),
      service: deniedService
    };
    const getResponse = await createAdminProviderQuickSetupSnapshotHandler(deps as never)(
      new Request("http://localhost/api/admin/providers/quick-setup")
    );
    const postResponse = await createAdminProviderQuickSetupMutationHandler(deps as never)(
      new Request("http://localhost/api/admin/providers/quick-setup", {
        body: JSON.stringify({
          expectedState: "state-token",
          provider: "openai",
          secret: "sk-secret"
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(deniedService.getSnapshot).not.toHaveBeenCalled();
    expect(deniedService.setup).not.toHaveBeenCalled();
  });

  it.each([
    [{ expectedState: "state-token", extra: true, provider: "openai", secret: "sk-secret" }],
    [{
      expectedState: "state-token",
      provider: "openai",
      secret: "sk-secret",
      selectedModel: { candidateId: "p2-o2", extra: true, policyVersion: 3 }
    }],
    [{ connectionDisplayName: "   ", expectedState: "state-token", provider: "openai", secret: "sk-secret" }],
    [{
      configuration: { allowPrivateNetwork: false, apiRoot: "https://gateway.example.test/v1", responseTimeoutSeconds: 120 },
      expectedState: "state-token",
      provider: "openai",
      secret: "sk-secret"
    }],
    [{
      configuration: { apiRoot: "https://gateway.example.test/v1", responseTimeoutSeconds: 1 },
      connectionDisplayName: "OpenAI via gateway",
      expectedState: "state-token",
      provider: "openai",
      secret: "sk-secret"
    }]
  ])("rejects request fields outside the exact contract", async (body) => {
    const quickService = service();
    const response = await createAdminProviderQuickSetupMutationHandler({
      resolveAuth: vi.fn(async () => session),
      service: quickService
    })(new Request("http://localhost/api/admin/providers/quick-setup", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(400);
    expect(quickService.setup).not.toHaveBeenCalled();
  });

  it("passes only the authenticated actor and validated write-only request", async () => {
    const setup = vi.fn(async () => ({
      checkedAt: "2026-07-26T10:00:00.000Z",
      connectionId: "00000000-0000-4000-8000-000000001102",
      defaultCredentialChanged: true,
      defaultChanged: true,
      model: { displayName: "GPT-5.6 Luna" },
      models: [{ displayName: "GPT-5.6 Luna" }],
      outcome: "ready" as const,
      provider: "openai" as const,
      providerDisplayName: "OpenAI"
    }));
    const handler = createAdminProviderQuickSetupMutationHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({ setup })
    });
    const response = await handler(new Request("http://localhost/api/admin/providers/quick-setup", {
      body: JSON.stringify({
        expectedState: "state-token",
        provider: "openai",
        secret: "sk-write-only",
        selectedModel: { candidateId: "p2-o2", policyVersion: 3 }
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(200);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      actor: { sessionId: "session-admin", userId: "admin" },
      request: expect.objectContaining({ expectedState: "state-token", provider: "openai" })
    }));
    expect(JSON.stringify(await response.json())).not.toContain("sk-write-only");
  });

  it("passes the connection name and endpoint overrides of a separate connection", async () => {
    const setup = vi.fn(async () => ({
      checkedAt: "2026-07-26T10:00:00.000Z",
      connectionId: "connection-second",
      defaultCredentialChanged: true,
      defaultChanged: false,
      model: { displayName: "GPT-5.6 Terra" },
      models: [{ displayName: "GPT-5.6 Terra" }],
      outcome: "ready" as const,
      provider: "openai" as const,
      providerDisplayName: "OpenAI",
      search: null
    }));
    const handler = createAdminProviderQuickSetupMutationHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({ setup })
    });
    const response = await handler(new Request("http://localhost/api/admin/providers/quick-setup", {
      body: JSON.stringify({
        configuration: {
          allowPrivateNetwork: false,
          apiRoot: "https://gateway.example.test/v1",
          responseTimeoutSeconds: 120
        },
        connectionDisplayName: "OpenAI via gateway",
        expectedState: "state-token",
        provider: "openai",
        secret: "sk-write-only"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(200);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      request: {
        configuration: {
          allowPrivateNetwork: false,
          apiRoot: "https://gateway.example.test/v1",
          responseTimeoutSeconds: 120
        },
        connectionDisplayName: "OpenAI via gateway",
        expectedState: "state-token",
        provider: "openai",
        secret: "sk-write-only"
      }
    }));
    expect(await response.json()).toMatchObject({ connectionId: "connection-second" });
  });

  it("maps an invalid endpoint override to a 400 without a stack trace", async () => {
    const handler = createAdminProviderQuickSetupMutationHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({
        setup: vi.fn(async () => { throw new ProviderConfigurationError("provider_api_root_invalid"); })
      })
    });
    const response = await handler(new Request("http://localhost/api/admin/providers/quick-setup", {
      body: JSON.stringify({
        configuration: { allowPrivateNetwork: false, apiRoot: "https://x.example.test", responseTimeoutSeconds: 30 },
        connectionDisplayName: "OpenAI via gateway",
        expectedState: "state-token",
        provider: "openai",
        secret: "sk-secret"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "provider_configuration_invalid" });
  });

  it.each([
    ["provider_draft_stale", 409],
    ["provider_quick_setup_advanced_required", 409],
    ["provider_quick_setup_name_taken", 409],
    ["provider_quick_setup_selection_invalid", 400],
    ["provider_quick_setup_unsupported_catalog", 422],
    ["provider_credential_test_failed", 422]
  ] as const)("maps %s to a safe status", async (code, status) => {
    const handler = createAdminProviderQuickSetupMutationHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({
        setup: vi.fn(async () => { throw new AdminProviderQuickSetupServiceError(code); })
      })
    });
    const response = await handler(new Request("http://localhost/api/admin/providers/quick-setup", {
      body: JSON.stringify({
        expectedState: "state-token",
        provider: "openai",
        secret: "sk-secret"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });
});
