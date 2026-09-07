// @vitest-environment node

import type { AuthenticatedSession, RequestAuthResolver } from "../auth/requestAuth";
import type { AdminEmailConfiguration, AdminEmailState } from "../../contracts/email";
import {
  createAdminEmailActionHandler,
  createAdminEmailClearHandler,
  createAdminEmailReadHandler
} from "./handlers";
import type { AdminEmailService } from "./service";

const previousActive: AdminEmailConfiguration = {
  allowInternalNetwork: false,
  authentication: { mode: "none" },
  from: { address: "noreply@example.com", displayName: "AIQSA" },
  host: "smtp.old.example.com",
  port: 465,
  transport: "implicit_tls"
};

function state(overrides: Partial<AdminEmailState> = {}): AdminEmailState {
  return {
    active: {
      activatedAt: null,
      activatedByUserId: null,
      configuration: null,
      enabled: false,
      passwordConfigured: false,
      version: 0
    },
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    draft: {
      configuration: null,
      passwordConfigured: false,
      test: null,
      version: 0
    },
    health: {
      activeVersion: null,
      degraded: false,
      lastAcceptedAt: null,
      lastAttemptAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    },
    ...overrides
  };
}

function session(overrides: Partial<AuthenticatedSession["user"]> = {}): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-07-24T00:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Operator",
      email: "operator@example.com",
      id: "admin-1",
      role: "admin",
      status: "active",
      ...overrides
    },
    userId: "admin-1"
  };
}

function service(overrides: Partial<AdminEmailService> = {}): AdminEmailService {
  const ok = async () => ({ ok: true as const, value: state() });
  return {
    clear: ok,
    disable: ok,
    enable: ok,
    read: ok,
    testAndActivate: async () => ({
      ok: true,
      value: { email: state(), test: { code: "accepted", tested: true } }
    }),
    ...overrides
  };
}

function request(method: string, body?: unknown): Request {
  return new Request("https://aiqsa.example/api/admin/email", {
    body: typeof body === "undefined" ? undefined : JSON.stringify(body),
    headers: typeof body === "undefined" ? undefined : { "content-type": "application/json" },
    method
  });
}

function testAndActivateBody(secret: string) {
  return {
    action: "test_and_activate",
    draft: {
      configuration: {
        allowInternalNetwork: false,
        authentication: { mode: "password", username: "mailer@example.com" },
        from: { address: "noreply@example.com", displayName: "AIQSA" },
        host: "smtp.example.com",
        port: 587,
        transport: "starttls_required"
      },
      expectedDraftVersion: 4,
      passwordAction: { kind: "replace", password: secret }
    },
    expectedActiveVersion: 3,
    testRecipient: "one-use@example.com"
  };
}

describe("admin email handlers", () => {
  it("requires an active administrator for reads and mutations", async () => {
    const read = vi.fn(service().read);
    const anonymous = createAdminEmailReadHandler({
      resolveAuth: async () => null,
      service: service({ read })
    });
    expect((await anonymous(request("GET"))).status).toBe(401);

    const ordinary = createAdminEmailActionHandler({
      resolveAuth: async () => session({ role: "member" }),
      service: service({ read })
    });
    expect((await ordinary(request("POST", {}))).status).toBe(403);

    const inactive = createAdminEmailActionHandler({
      resolveAuth: async () => session({ status: "disabled" }),
      service: service({ read })
    });
    expect((await inactive(request("POST", {}))).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("passes normalized write-only settings and the one-use recipient to test_and_activate and returns only sanitized evidence", async () => {
    const secret = "write-only-password";
    const testAndActivate = vi.fn(service().testAndActivate);
    const handler = createAdminEmailActionHandler({
      resolveAuth: (async () => session()) as RequestAuthResolver,
      service: service({ testAndActivate })
    });
    const response = await handler(request("POST", testAndActivateBody(secret)));

    expect(response.status).toBe(200);
    expect(testAndActivate).toHaveBeenCalledWith({
      actorUserId: "admin-1",
      configuration: expect.objectContaining({ host: "smtp.example.com", port: 587 }),
      expectedActiveVersion: 3,
      expectedDraftVersion: 4,
      passwordAction: { kind: "replace", password: secret },
      testRecipient: "one-use@example.com"
    });
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('"test":{"code":"accepted","tested":true}');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("one-use@example.com");
    expect(serialized).not.toContain("Envelope");
  });

  it("answers a rejected test message with 422, the cause, and the untouched previous active configuration", async () => {
    const secret = "write-only-password";
    const stored = state({
      active: {
        activatedAt: "2026-07-01T00:00:00.000Z",
        activatedByUserId: "admin-0",
        configuration: previousActive,
        enabled: true,
        passwordConfigured: false,
        version: 3
      },
      draft: {
        configuration: { ...previousActive, host: "smtp.example.com" },
        passwordConfigured: true,
        test: {
          attemptedAt: "2026-07-23T13:00:00.000Z",
          code: "smtp_authentication_failed",
          tested: false,
          version: 5
        },
        version: 5
      }
    });
    const handler = createAdminEmailActionHandler({
      resolveAuth: async () => session(),
      service: service({
        testAndActivate: async () => ({
          ok: false,
          code: "test_failed",
          value: { email: stored, test: { code: "smtp_authentication_failed", tested: false } }
        })
      })
    });
    const response = await handler(request("POST", testAndActivateBody(secret)));

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      email: stored,
      error: "email_test_failed",
      test: { code: "smtp_authentication_failed", tested: false }
    });
    expect(body.email.active.configuration.host).toBe("smtp.old.example.com");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("one-use@example.com");
  });

  it("maps repository refusals to stable value-free codes", async () => {
    const secret = "must-never-echo";
    const conflict = createAdminEmailActionHandler({
      resolveAuth: async () => session(),
      service: service({ testAndActivate: async () => ({ ok: false, code: "active_conflict" }) })
    });
    const stale = await conflict(request("POST", testAndActivateBody(secret)));
    expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).toBe('{"error":"email_active_conflict"}');

    const unavailable = createAdminEmailActionHandler({
      resolveAuth: async () => session(),
      service: service({ testAndActivate: async () => ({ ok: false, code: "encryption_unavailable" }) })
    });
    expect((await unavailable(request("POST", testAndActivateBody(secret)))).status).toBe(503);
  });

  it("returns stable value-free validation errors and rejects ambiguous clear", async () => {
    const secret = "must-never-echo";
    const testAndActivate = vi.fn(service().testAndActivate);
    const action = createAdminEmailActionHandler({ resolveAuth: async () => session(), service: service({ testAndActivate }) });
    const invalid = await action(request("POST", {
      action: "test_and_activate",
      draft: {
        configuration: { host: secret },
        expectedDraftVersion: 0,
        passwordAction: { kind: "replace", password: secret }
      },
      expectedActiveVersion: 0,
      testRecipient: "operator@example.com"
    }));
    expect(invalid.status).toBe(400);
    const invalidBody = JSON.stringify(await invalid.json());
    expect(invalidBody).toBe('{"error":"email_configuration_invalid"}');
    expect(invalidBody).not.toContain(secret);

    const badRecipient = await action(request("POST", {
      ...testAndActivateBody(secret),
      testRecipient: "victim@example.com\r\nBcc: attacker@example.com"
    }));
    expect(badRecipient.status).toBe(400);
    expect(testAndActivate).not.toHaveBeenCalled();

    const removed = await action(request("POST", { action: "activate", expectedActiveVersion: 0, expectedDraftVersion: 0 }));
    expect(removed.status).toBe(400);

    const clear = createAdminEmailClearHandler({ resolveAuth: async () => session(), service: service() });
    const rejected = await clear(request("DELETE", {
      confirm: false,
      expectedActiveVersion: 0,
      expectedDraftVersion: 0
    }));
    expect(rejected.status).toBe(400);
  });

  it("turns delivery on and off with the acting administrator identity", async () => {
    const disable = vi.fn(service().disable);
    const enable = vi.fn(service().enable);
    const handler = createAdminEmailActionHandler({
      resolveAuth: async () => session(),
      service: service({ disable, enable })
    });

    expect((await handler(request("POST", { action: "disable", expectedActiveVersion: 3 }))).status).toBe(200);
    expect(disable).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedActiveVersion: 3 });
    expect((await handler(request("POST", { action: "enable", expectedActiveVersion: 4 }))).status).toBe(200);
    expect(enable).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedActiveVersion: 4 });
  });
});
