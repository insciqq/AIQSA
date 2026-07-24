// @vitest-environment node

import type { AuthenticatedSession, RequestAuthResolver } from "../auth/requestAuth";
import type { AdminEmailState } from "../../contracts/email";
import {
  createAdminEmailActionHandler,
  createAdminEmailClearHandler,
  createAdminEmailReadHandler,
  createAdminEmailSaveHandler
} from "./handlers";
import type { AdminEmailService } from "./service";

function state(): AdminEmailState {
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
    }
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
    activate: ok,
    clear: ok,
    disable: ok,
    enable: ok,
    read: ok,
    saveDraft: ok,
    testDraft: async () => ({
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

describe("admin email handlers", () => {
  it("requires an active administrator for reads and mutations", async () => {
    const read = vi.fn(service().read);
    const anonymous = createAdminEmailReadHandler({
      resolveAuth: async () => null,
      service: service({ read })
    });
    expect((await anonymous(request("GET"))).status).toBe(401);

    const ordinary = createAdminEmailSaveHandler({
      resolveAuth: async () => session({ role: "member" }),
      service: service({ read })
    });
    expect((await ordinary(request("PUT", {}))).status).toBe(403);

    const inactive = createAdminEmailActionHandler({
      resolveAuth: async () => session({ status: "disabled" }),
      service: service({ read })
    });
    expect((await inactive(request("POST", {}))).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it("passes normalized write-only save data with the acting administrator identity", async () => {
    const saveDraft = vi.fn(service().saveDraft);
    const handler = createAdminEmailSaveHandler({
      resolveAuth: (async () => session()) as RequestAuthResolver,
      service: service({ saveDraft })
    });
    const response = await handler(request("PUT", {
      configuration: {
        allowInternalNetwork: false,
        authentication: { mode: "password", username: "mailer@example.com" },
        from: { address: "noreply@example.com", displayName: "AIQSA" },
        host: "smtp.example.com",
        port: 587,
        transport: "starttls_required"
      },
      expectedDraftVersion: 0,
      passwordAction: { kind: "replace", password: "write-only-password" }
    }));

    expect(response.status).toBe(200);
    expect(saveDraft).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      expectedDraftVersion: 0,
      passwordAction: { kind: "replace", password: "write-only-password" }
    }));
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("write-only-password");
    expect(serialized).not.toContain("Envelope");
  });

  it("returns stable value-free validation errors and rejects ambiguous clear", async () => {
    const secret = "must-never-echo";
    const save = createAdminEmailSaveHandler({ resolveAuth: async () => session(), service: service() });
    const invalid = await save(request("PUT", {
      configuration: { host: secret },
      expectedDraftVersion: 0,
      passwordAction: { kind: "replace", password: secret }
    }));
    expect(invalid.status).toBe(400);
    const invalidBody = JSON.stringify(await invalid.json());
    expect(invalidBody).toBe('{"error":"email_configuration_invalid"}');
    expect(invalidBody).not.toContain(secret);

    const clear = createAdminEmailClearHandler({ resolveAuth: async () => session(), service: service() });
    const rejected = await clear(request("DELETE", {
      confirm: false,
      expectedActiveVersion: 0,
      expectedDraftVersion: 0
    }));
    expect(rejected.status).toBe(400);
  });

  it("keeps test recipients ephemeral and returns only sanitized evidence", async () => {
    const testDraft = vi.fn(service().testDraft);
    const handler = createAdminEmailActionHandler({
      resolveAuth: async () => session(),
      service: service({ testDraft })
    });
    const response = await handler(request("POST", {
      action: "test",
      expectedDraftVersion: 3,
      recipient: "one-use@example.com"
    }));
    expect(response.status).toBe(200);
    expect(testDraft).toHaveBeenCalledWith({
      expectedDraftVersion: 3,
      recipient: "one-use@example.com"
    });
    expect(JSON.stringify(await response.json())).not.toContain("one-use@example.com");
  });
});
