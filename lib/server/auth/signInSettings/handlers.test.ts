import { describe, expect, it, vi } from "vitest";
import type { AdminSignInMethodState } from "@/lib/contracts/adminSignIn";
import type { AuthenticatedSession } from "../requestAuth";
import {
  createAdminSignInMethodHandlers,
  createAdminSignInPolicyHandler,
  createAdminSignInReadHandler
} from "./handlers";
import type { SignInSettingsService } from "./service";

const adminSession: AuthenticatedSession = {
  expiresAt: new Date("2026-10-09T00:00:00.000Z"),
  id: "session-admin",
  user: { displayName: "Admin", email: "admin@example.com", id: "admin", role: "admin", status: "active" },
  userId: "admin"
};

const methodState = { method: "google", status: "off" } as unknown as AdminSignInMethodState;

function fakeService(overrides: Partial<SignInSettingsService> = {}): SignInSettingsService {
  return {
    activate: vi.fn(async () => ({ ok: true as const, value: methodState })),
    disable: vi.fn(async () => ({ ok: true as const, value: methodState })),
    isAvailable: vi.fn((method) => method === "google" || method === "yandex"),
    overview: vi.fn(async () => ({
      appBaseUrl: "https://aiqsa.example",
      currentSessionSignInMethod: "password" as const,
      methods: [],
      policy: { passwordLoginEnabled: true, registrationEnabled: true, updatedAt: null, version: 0 }
    })),
    readPolicy: vi.fn(async () => ({ passwordLoginEnabled: true, registrationEnabled: true })),
    saveDraft: vi.fn(async () => ({ ok: true as const, value: methodState })),
    test: vi.fn(async () => ({ ok: true as const, value: { method: methodState, test: { code: "format_checked", passed: true } } })),
    updatePolicy: vi.fn(async () => ({
      ok: true as const,
      value: { passwordLoginEnabled: false, registrationEnabled: true, updatedAt: null, version: 1 }
    })),
    ...overrides
  };
}

function deps(service: SignInSettingsService, session: AuthenticatedSession | null = adminSession) {
  return { resolveAuth: vi.fn(async () => session), service };
}

function json(method: string, body: unknown, contentType = "application/json"): Request {
  return new Request("http://localhost:3000/api/admin/sign-in/methods/google", {
    body: JSON.stringify(body),
    headers: { "content-type": contentType },
    method
  });
}

const google = { params: { method: "google" } };

describe("admin sign-in handlers", () => {
  it("lets only active administrators read or change sign-in settings", async () => {
    const service = fakeService();
    const user = { ...adminSession, user: { ...adminSession.user, role: "user" } };

    expect((await createAdminSignInReadHandler(deps(service, null))(new Request("http://localhost:3000/api/admin/sign-in"))).status).toBe(401);
    expect((await createAdminSignInReadHandler(deps(service, user))(new Request("http://localhost:3000/api/admin/sign-in"))).status).toBe(403);
    expect((await createAdminSignInMethodHandlers(deps(service, user)).PUT(json("PUT", {}), google)).status).toBe(403);
    expect((await createAdminSignInPolicyHandler(deps(service, user))(json("PUT", {}))).status).toBe(403);
    expect(service.overview).not.toHaveBeenCalled();

    const read = await createAdminSignInReadHandler(deps(service))(new Request("http://localhost:3000/api/admin/sign-in"));
    expect(read.status).toBe(200);
    expect(service.overview).toHaveBeenCalledWith({ sessionId: "session-admin" });
  });

  it("saves a draft with validated write-only secret actions", async () => {
    const service = fakeService();
    const { PUT } = createAdminSignInMethodHandlers(deps(service));

    expect((await PUT(json("PUT", {}, "text/plain"), google)).status).toBe(415);
    expect((await PUT(json("PUT", { config: {}, expectedDraftVersion: 0 }), { params: { method: "github" } })).status).toBe(404);
    expect((await PUT(json("PUT", { config: {}, expectedDraftVersion: 0 }), { params: { method: "oidc" } })).status).toBe(404);
    expect((await PUT(json("PUT", { config: {}, expectedDraftVersion: -1 }), google)).status).toBe(400);
    expect((await PUT(json("PUT", { config: {}, expectedDraftVersion: 0, extra: 1 }), google)).status).toBe(400);
    expect((await PUT(json("PUT", {
      config: {},
      expectedDraftVersion: 0,
      secretActions: { clientSecret: { kind: "clear" } }
    }), google)).status).toBe(400);
    expect(service.saveDraft).not.toHaveBeenCalled();

    const saved = await PUT(json("PUT", {
      config: { clientId: "client" },
      expectedDraftVersion: 3,
      secretActions: { clientSecret: { kind: "replace", value: "new-secret" } }
    }), google);

    expect(saved.status).toBe(200);
    expect(service.saveDraft).toHaveBeenCalledWith({
      actorUserId: "admin",
      config: { clientId: "client" },
      expectedDraftVersion: 3,
      method: "google",
      secretActions: { clientSecret: { kind: "replace", value: "new-secret" } }
    });
  });

  it("runs test, activate and disable and maps refusals to stable codes", async () => {
    const service = fakeService({
      activate: vi.fn(async () => ({ affectedIdentities: 2, code: "source_changed" as const, ok: false as const }))
    });
    const { POST } = createAdminSignInMethodHandlers(deps(service));

    const tested = await POST(json("POST", { action: "test", expectedDraftVersion: 2 }), google);
    await expect(tested.json()).resolves.toMatchObject({ test: { code: "format_checked", passed: true } });

    const activation = await POST(json("POST", { action: "activate", expectedActiveVersion: 0, expectedDraftVersion: 2 }), google);
    expect(activation.status).toBe(409);
    await expect(activation.json()).resolves.toEqual({ affectedIdentities: 2, error: "sign_in_source_changed" });

    await POST(json("POST", { action: "activate", confirmSourceChange: true, expectedActiveVersion: 0, expectedDraftVersion: 2 }), google);
    expect(service.activate).toHaveBeenLastCalledWith({
      actorUserId: "admin",
      confirmSourceChange: true,
      expectedActiveVersion: 0,
      expectedDraftVersion: 2,
      method: "google"
    });
    expect((await POST(json("POST", { action: "activate", confirmSourceChange: false, expectedActiveVersion: 0, expectedDraftVersion: 2 }), google)).status).toBe(400);
    expect((await POST(json("POST", { action: "disable", expectedActiveVersion: 1 }), google)).status).toBe(200);
    expect(service.disable).toHaveBeenCalledWith({
      actorUserId: "admin",
      expectedActiveVersion: 1,
      method: "google",
      sessionId: "session-admin"
    });
    expect((await POST(json("POST", { action: "delete" }), google)).status).toBe(400);

    const notTested = createAdminSignInMethodHandlers(deps(fakeService({
      activate: vi.fn(async () => ({ code: "not_tested" as const, ok: false as const }))
    })));
    const refused = await notTested.POST(json("POST", { action: "activate", expectedActiveVersion: 0, expectedDraftVersion: 2 }), google);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: "sign_in_draft_not_tested" });
  });

  it("refuses to disable the acting session's own way in while passwords are off", async () => {
    const { POST } = createAdminSignInMethodHandlers(deps(fakeService({
      disable: vi.fn(async () => ({ code: "lockout_risk" as const, ok: false as const }))
    })));

    const response = await POST(json("POST", { action: "disable", expectedActiveVersion: 1 }), google);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "password_login_lockout_risk" });
  });

  it("changes the switches for the acting session and reports the lockout risk", async () => {
    const service = fakeService({
      updatePolicy: vi.fn(async () => ({ code: "lockout_risk" as const, ok: false as const }))
    });
    const PUT = createAdminSignInPolicyHandler(deps(service));

    expect((await PUT(json("PUT", { expectedVersion: 0, passwordLoginEnabled: "no", registrationEnabled: true }))).status).toBe(400);
    const response = await PUT(json("PUT", { expectedVersion: 0, passwordLoginEnabled: false, registrationEnabled: true }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "password_login_lockout_risk" });
    expect(service.updatePolicy).toHaveBeenCalledWith({
      actorUserId: "admin",
      expectedVersion: 0,
      passwordLoginEnabled: false,
      registrationEnabled: true,
      sessionId: "session-admin"
    });
  });
});
