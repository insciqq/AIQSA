import type { AdminEmailState } from "@/lib/contracts/email";
import {
  clearAdminEmail,
  requestAdminEmail,
  runAdminEmailAction,
  saveAdminEmail
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

describe("admin email API client", () => {
  it("uses one route family with explicit JSON mutation methods", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ email: state() })
    );

    await requestAdminEmail(fetcher);
    await saveAdminEmail({
      configuration: {
        allowInternalNetwork: false,
        authentication: { mode: "none" },
        from: { address: "noreply@example.com", displayName: null },
        host: "smtp.example.com",
        port: 465,
        transport: "implicit_tls"
      },
      expectedDraftVersion: 4,
      passwordAction: { confirm: true, kind: "clear" }
    }, fetcher);
    await runAdminEmailAction({ action: "disable", expectedActiveVersion: 2 }, fetcher);
    await clearAdminEmail({
      confirm: true,
      expectedActiveVersion: 2,
      expectedDraftVersion: 4
    }, fetcher);

    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual([
      "GET",
      "PUT",
      "POST",
      "DELETE"
    ]);
    expect(fetcher.mock.calls.every(([url]) => url === "/api/admin/email")).toBe(true);
    expect(fetcher.mock.calls.slice(1).every(([, init]) =>
      new Headers(init?.headers).get("content-type") === "application/json"
    )).toBe(true);
  });

  it("decodes safe state and rejects malformed success payloads", async () => {
    const good = await requestAdminEmail(vi.fn(async () => response({ email: state() })));
    expect(good).toEqual({ data: { email: state() }, ok: true });

    const malformed = await requestAdminEmail(vi.fn(async () => response({
      email: { ...state(), draft: { password: "leak" } }
    })));
    expect(malformed).toEqual({ error: "email_admin_response_invalid", ok: false });
  });

  it("keeps server errors value-free", async () => {
    const result = await requestAdminEmail(vi.fn(async () => response({
      error: "email_state_invalid",
      ignored: "unsafe detail"
    }, 409)));
    expect(result).toEqual({ error: "email_state_invalid", ok: false });
  });
});
