import { describe, expect, it, vi } from "vitest";
import { AdminProviderCredentialTestError } from "./credentialTester";
import { createAdminProviderCustomDiscoveryHandler } from "./customSetupDiscoveryHandlers";

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

function post(body: unknown) {
  return new Request("http://localhost/api/admin/providers/custom-setup/discover", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

describe("custom provider model discovery handler", () => {
  it("requires an active administrator", async () => {
    const response = await createAdminProviderCustomDiscoveryHandler({
      resolveAuth: vi.fn(async () => null),
      tester: { test: vi.fn() }
    })(post({}));
    expect(response.status).toBe(401);
  });

  it("returns ordered models with an empty safe capability contract for an id-only tester", async () => {
    const test = vi.fn(async () => ({
      method: "models_catalog" as const,
      modelIds: ["model-b", "model-a"]
    }));
    const response = await createAdminProviderCustomDiscoveryHandler({
      now: () => new Date("2026-07-28T12:00:00.000Z"),
      resolveAuth: vi.fn(async () => session),
      tester: { test }
    } as never)(post({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      secret: "write-only-key"
    }));

    expect(response.status).toBe(200);
    expect(test).toHaveBeenCalledWith(expect.objectContaining({
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://llm.example.test/v1",
        authenticationMode: "bearer"
      },
      family: "openai_compatible",
      secret: "write-only-key"
    }));
    const text = await response.text();
    expect(text).not.toContain("write-only-key");
    expect(text).not.toContain("apiRoot");
    expect(JSON.parse(text)).toEqual({
      checkedAt: "2026-07-28T12:00:00.000Z",
      modelCount: 2,
      models: [
        { capabilities: {}, id: "model-b" },
        { capabilities: {}, id: "model-a" }
      ],
      source: "models_catalog",
      status: "valid"
    });
  });

  it("does not reflect provider failures or secrets", async () => {
    const response = await createAdminProviderCustomDiscoveryHandler({
      resolveAuth: vi.fn(async () => session),
      tester: { test: vi.fn(async () => { throw new AdminProviderCredentialTestError(); }) }
    } as never)(post({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      secret: "write-only-key"
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "provider_custom_setup_discovery_failed"
    });
  });
});
