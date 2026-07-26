import { describe, expect, it, vi } from "vitest";
import { createAdminProviderCustomSetupHandler } from "./customSetupHandlers";
import {
  AdminProviderCustomSetupServiceError,
  type AdminProviderCustomSetupService
} from "./customSetupService";

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

function service(
  overrides: Partial<AdminProviderCustomSetupService> = {}
): AdminProviderCustomSetupService {
  return {
    setup: vi.fn(async () => ({
      authenticationMode: "bearer" as const,
      checkedAt: "2026-07-26T10:00:00.000Z",
      connectionDisplayName: "Custom · llm.example.test",
      connectionId: "connection-1",
      defaultChanged: true,
      modelDisplayName: "vendor/model-1",
      outcome: "ready" as const,
      providerModelId: "model-1"
    })),
    ...overrides
  };
}

function post(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/admin/providers/custom-setup", {
    body: JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "POST"
  });
}

describe("custom provider setup handler", () => {
  it("requires an active administrator", async () => {
    const anonymous = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => null),
      service: service()
    })(post({}));
    const ordinary = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => ({
        ...session,
        user: { ...session.user, role: "user" }
      })),
      service: service()
    } as never)(post({}));

    expect(anonymous.status).toBe(401);
    expect(ordinary.status).toBe(403);
  });

  it("accepts one exact bearer request and returns only the safe Ready receipt", async () => {
    const setup = vi.fn(async () => ({
      authenticationMode: "bearer" as const,
      checkedAt: "2026-07-26T10:00:00.000Z",
      connectionDisplayName: "Local lab",
      connectionId: "connection-1",
      defaultChanged: false,
      modelDisplayName: "Lab model",
      outcome: "ready" as const,
      providerModelId: "model-1"
    }));
    const response = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({ setup })
    })(post({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      capabilities: {
        contextWindow: 16_384,
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: true,
        toolCalling: false,
        vision: false
      },
      confirmPaidRequest: true,
      connectionDisplayName: "Local lab",
      modelDisplayName: "Lab model",
      modelId: "vendor/model-1",
      secret: "write-only-key"
    }));

    expect(response.status).toBe(200);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      actor: { sessionId: "session-admin", userId: "admin" },
      request: expect.objectContaining({
        authenticationMode: "bearer",
        secret: "write-only-key"
      })
    }));
    const text = await response.text();
    expect(text).not.toContain("write-only-key");
    expect(text).not.toContain("apiRoot");
    expect(JSON.parse(text)).toEqual({
      authenticationMode: "bearer",
      checkedAt: "2026-07-26T10:00:00.000Z",
      connectionDisplayName: "Local lab",
      connectionId: "connection-1",
      defaultChanged: false,
      modelDisplayName: "Lab model",
      outcome: "ready",
      providerModelId: "model-1"
    });
  });

  it("accepts no secret only for the explicit none request shape", async () => {
    const setup = vi.fn(service().setup);
    const response = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({ setup })
    })(post({
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      confirmPaidRequest: true,
      modelId: "local-model"
    }));

    expect(response.status).toBe(200);
    expect(setup.mock.calls[0]![0].request).not.toHaveProperty("secret");
  });

  it.each([
    [{}, 400],
    [{
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      confirmPaidRequest: true,
      modelId: "model-1"
    }, 400],
    [{
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1/v1",
      authenticationMode: "none",
      confirmPaidRequest: true,
      modelId: "model-1",
      secret: "must-not-be-accepted"
    }, 400],
    [{
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      confirmPaidRequest: true,
      modelId: "model-1",
      secret: "key",
      unexpected: true
    }, 400]
  ])("rejects malformed or ambiguous request bodies", async (body, expectedStatus) => {
    const customService = service();
    const response = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => session),
      service: customService
    })(post(body));
    expect(response.status).toBe(expectedStatus);
    expect(customService.setup).not.toHaveBeenCalled();
  });

  it("maps sanitized service failures without reflecting remote details", async () => {
    const response = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => session),
      service: service({
        setup: vi.fn(async () => {
          throw new AdminProviderCustomSetupServiceError(
            "provider_custom_setup_test_failed"
          );
        })
      })
    })(post({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      confirmPaidRequest: true,
      modelId: "model-1",
      secret: "private-key"
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "provider_custom_setup_test_failed"
    });
  });

  it("requires JSON content", async () => {
    const response = await createAdminProviderCustomSetupHandler({
      resolveAuth: vi.fn(async () => session),
      service: service()
    })(post({}, "text/plain"));
    expect(response.status).toBe(415);
  });
});
