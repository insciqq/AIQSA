// @vitest-environment node

import type { AdminEmailState } from "@/lib/contracts/email";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  resolveAuth: vi.fn(),
  testAndActivate: vi.fn()
}));

vi.mock("@/lib/server/auth/defaultAuth", () => ({
  resolveRequestAuth: mocks.resolveAuth
}));

vi.mock("@/lib/server/email/defaultEmail", () => ({
  adminEmailService: {
    clear: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    read: mocks.read,
    testAndActivate: mocks.testAndActivate
  }
}));

import * as route from "./route";

const emptyState: AdminEmailState = {
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
  draft: { configuration: null, passwordConfigured: false, test: null, version: 0 },
  health: {
    activeVersion: null,
    degraded: false,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null
  }
};

const testAndActivateBody = {
  action: "test_and_activate",
  draft: {
    configuration: {
      allowInternalNetwork: false,
      authentication: { mode: "none" },
      from: { address: "noreply@example.com", displayName: null },
      host: "smtp.example.com",
      port: 465,
      transport: "implicit_tls"
    },
    expectedDraftVersion: 0,
    passwordAction: { confirm: true, kind: "clear" }
  },
  expectedActiveVersion: 0,
  testRecipient: "operator@example.com"
};

function post(body: unknown): Request {
  return new Request("https://aiqsa.example/api/admin/email", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

describe("/api/admin/email", () => {
  beforeEach(() => {
    mocks.resolveAuth.mockResolvedValue({
      expiresAt: new Date("2026-07-24T00:00:00.000Z"),
      id: "session-1",
      user: {
        displayName: "Operator",
        email: "operator@example.com",
        id: "admin-1",
        role: "admin",
        status: "active"
      },
      userId: "admin-1"
    });
  });

  it("wires the Node route to the active-admin email service without a separate save route", async () => {
    mocks.read.mockResolvedValue({ ok: true, value: emptyState });

    expect(route.runtime).toBe("nodejs");
    expect("PUT" in route).toBe(false);
    const response = await route.GET(new Request("https://aiqsa.example/api/admin/email"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: emptyState });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it("activates through test_and_activate when the test message is accepted", async () => {
    const activated: AdminEmailState = {
      ...emptyState,
      active: {
        ...emptyState.active,
        configuration: testAndActivateBody.draft.configuration,
        enabled: true,
        version: 1
      }
    };
    mocks.testAndActivate.mockResolvedValue({
      ok: true,
      value: { email: activated, test: { code: "accepted", tested: true } }
    });

    const response = await route.POST(post(testAndActivateBody));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      email: activated,
      test: { code: "accepted", tested: true }
    });
    expect(mocks.testAndActivate).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: "admin-1",
      expectedActiveVersion: 0,
      expectedDraftVersion: 0,
      testRecipient: "operator@example.com"
    }));
  });

  it("keeps the previous active configuration and reports the cause when the test message fails", async () => {
    const stored: AdminEmailState = {
      ...emptyState,
      draft: {
        configuration: testAndActivateBody.draft.configuration,
        passwordConfigured: false,
        test: { attemptedAt: "2026-07-23T13:00:00.000Z", code: "smtp_connection_failed", tested: false, version: 1 },
        version: 1
      }
    };
    mocks.testAndActivate.mockResolvedValue({
      ok: false,
      code: "test_failed",
      value: { email: stored, test: { code: "smtp_connection_failed", tested: false } }
    });

    const response = await route.POST(post(testAndActivateBody));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({
      email: stored,
      error: "email_test_failed",
      test: { code: "smtp_connection_failed", tested: false }
    });
    expect(body.email.active).toEqual(emptyState.active);
    expect(JSON.stringify(body)).not.toContain("operator@example.com");
  });
});
