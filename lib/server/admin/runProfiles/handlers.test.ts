import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession, RequestAuthResolver } from "../../auth/requestAuth";
import {
  createAdminRunProfileCatalogHandler,
  createAdminRunProfileUpdateHandler
} from "./handlers";
import {
  AdminRunProfileServiceError,
  type AdminRunProfileService
} from "./service";

const catalog = {
  models: [],
  profiles: [
    { description: "Fast", enabled: false, id: "fast" as const, label: "Fast", providerModelId: null, reasoningEffort: "medium", reasoningMode: "standard", updatedAt: "2026-07-24T00:00:00.000Z", version: 1 },
    { description: "Balanced", enabled: false, id: "balanced" as const, label: "Balanced", providerModelId: null, reasoningEffort: "medium", reasoningMode: "standard", updatedAt: "2026-07-24T00:00:00.000Z", version: 1 },
    { description: "Deep", enabled: false, id: "deep" as const, label: "Deep", providerModelId: null, reasoningEffort: "max", reasoningMode: "pro", updatedAt: "2026-07-24T00:00:00.000Z", version: 1 }
  ]
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

function service(overrides: Partial<AdminRunProfileService> = {}): AdminRunProfileService {
  return {
    getCatalog: vi.fn(async () => catalog),
    update: vi.fn(async () => catalog),
    ...overrides
  };
}

function request(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/admin/run-profiles", {
    body: JSON.stringify(body),
    headers: { "content-type": contentType },
    method: "PUT"
  });
}

describe("admin run profile HTTP handlers", () => {
  it("allows only active administrators and requires JSON for writes", async () => {
    const profileService = service();
    const anonymous = createAdminRunProfileCatalogHandler({
      resolveAuth: resolver(null),
      service: profileService
    });
    const user = createAdminRunProfileUpdateHandler({
      resolveAuth: resolver(auth("user")),
      service: profileService
    });
    const inactiveAdmin = createAdminRunProfileCatalogHandler({
      resolveAuth: resolver(auth("admin", "disabled")),
      service: profileService
    });
    const nonJsonAdmin = createAdminRunProfileUpdateHandler({
      resolveAuth: resolver(auth()),
      service: profileService
    });

    expect((await anonymous(new Request("http://localhost/api/admin/run-profiles"))).status).toBe(401);
    expect((await user(request({ profiles: [] }))).status).toBe(403);
    expect((await inactiveAdmin(new Request("http://localhost/api/admin/run-profiles"))).status).toBe(403);
    expect((await nonJsonAdmin(request({ profiles: [] }, "text/plain"))).status).toBe(415);
    expect(profileService.update).not.toHaveBeenCalled();
  });

  it("passes the whole profile set and authenticated updater identity to one service call", async () => {
    const update = vi.fn(async () => catalog);
    const handler = createAdminRunProfileUpdateHandler({
      resolveAuth: resolver(auth()),
      service: service({ update })
    });
    const profiles = [{ id: "fast" }, { id: "balanced" }, { id: "deep" }];

    const response = await handler(request({ profiles }));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ profiles, updatedByUserId: "admin-1" });
    expect(await response.json()).toEqual(catalog);
  });

  it.each([
    ["run_profile_stale", 409],
    ["run_profile_target_invalid", 422],
    ["run_profile_configuration_invalid", 400]
  ] as const)("maps %s to HTTP %i", async (code, status) => {
    const handler = createAdminRunProfileUpdateHandler({
      resolveAuth: resolver(auth()),
      service: service({
        update: vi.fn(async () => { throw new AdminRunProfileServiceError(code); })
      })
    });

    const response = await handler(request({ profiles: [] }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("rejects malformed JSON without invoking the service", async () => {
    const profileService = service();
    const handler = createAdminRunProfileUpdateHandler({
      resolveAuth: resolver(auth()),
      service: profileService
    });
    const response = await handler(new Request("http://localhost/api/admin/run-profiles", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "PUT"
    }));

    expect(response.status).toBe(400);
    expect(profileService.update).not.toHaveBeenCalled();
  });
});
