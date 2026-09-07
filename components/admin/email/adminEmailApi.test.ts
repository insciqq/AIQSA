import type { AdminEmailState } from "@/lib/contracts/email";
import {
  clearAdminEmail,
  requestAdminEmail,
  runAdminEmailAction,
  testAndActivateAdminEmail
} from "./adminEmailApi";

function state(): AdminEmailState {
  return {
    active: {
      activatedAt: null,
      activatedByUserId: null,
      configuration: null,
      enabled: false,
      passwordConfigured: false,
      version: 2
    },
    configurationUpdatedAt: null,
    configurationUpdatedByUserId: null,
    draft: { configuration: null, passwordConfigured: false, test: null, version: 4 },
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

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

const testAndActivateBody = {
  action: "test_and_activate" as const,
  draft: {
    configuration: {
      allowInternalNetwork: false,
      authentication: { mode: "none" as const },
      from: { address: "noreply@example.com", displayName: null },
      host: "smtp.example.com",
      port: 465,
      transport: "implicit_tls" as const
    },
    expectedDraftVersion: 4,
    passwordAction: { confirm: true as const, kind: "clear" as const }
  },
  expectedActiveVersion: 2,
  testRecipient: "admin@example.com"
};

describe("admin email API client", () => {
  it("uses one route family with explicit JSON mutation methods", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ email: state(), test: { code: "accepted", tested: true } })
    );

    await requestAdminEmail(fetcher);
    await testAndActivateAdminEmail(testAndActivateBody, fetcher);
    await runAdminEmailAction({ action: "disable", expectedActiveVersion: 2 }, fetcher);
    await clearAdminEmail({
      confirm: true,
      expectedActiveVersion: 2,
      expectedDraftVersion: 4
    }, fetcher);

    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "POST",
      "POST",
      "DELETE"
    ]);
    expect(fetcher.mock.calls.every(([url]) => url === "/api/admin/email")).toBe(true);
    expect(fetcher.mock.calls.slice(1).every(([, init]) =>
      new Headers(init?.headers).get("content-type") === "application/json"
    )).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual(testAndActivateBody);
  });

  it("decodes safe state and rejects malformed success payloads", async () => {
    const good = await requestAdminEmail(vi.fn(async () => response({ email: state() })));
    expect(good).toEqual({ data: { email: state() }, ok: true });

    const malformed = await requestAdminEmail(vi.fn(async () => response({
      email: { ...state(), draft: { password: "leak" } }
    })));
    expect(malformed).toEqual({ error: "email_admin_response_invalid", ok: false });

    const activated = await testAndActivateAdminEmail(testAndActivateBody, vi.fn(async () => response({
      email: state(),
      test: { code: "accepted", tested: true }
    })));
    expect(activated).toEqual({ data: { email: state(), test: { code: "accepted", tested: true } }, ok: true });
  });

  it("turns a rejected test message into its cause with the stored settings, and keeps other errors value-free", async () => {
    const stored = state();
    const failed = await testAndActivateAdminEmail(testAndActivateBody, vi.fn(async () => response({
      email: stored,
      error: "email_test_failed",
      test: { code: "smtp_connection_failed", tested: false }
    }, 422)));
    expect(failed).toEqual({
      error: "email_test_failed",
      ok: false,
      testFailure: { code: "smtp_connection_failed", email: stored }
    });

    const conflict = await testAndActivateAdminEmail(testAndActivateBody, vi.fn(async () => response({
      error: "email_active_conflict",
      ignored: "unsafe detail"
    }, 409)));
    expect(conflict).toEqual({ error: "email_active_conflict", ok: false, testFailure: null });

    const result = await requestAdminEmail(vi.fn(async () => response({
      error: "email_state_invalid",
      ignored: "unsafe detail"
    }, 409)));
    expect(result).toEqual({ error: "email_state_invalid", ok: false });
  });
});
