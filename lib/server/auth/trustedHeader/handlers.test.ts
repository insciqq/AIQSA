// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { trustedHeaderSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { createTestAuth, createTestUser } from "@/tests/support/auth";
import { getAuthConfig } from "../config";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import type { AuthSessionRecord, AuthSessionStore } from "../requestAuth";
import { readCookie, SESSION_COOKIE_NAME } from "../session";
import type { ResolvedSignInMethod } from "../signInMethods";
import { hashToken } from "../token";
import { createAdminTrustedHeaderProbeHandler, createTrustedHeaderSignInHandler } from "./handlers";
import type { TrustedHeaderSignInRepository } from "./repository";

const SECRET = { AIQSA_AUTH_SESSION_SECRET: "trusted-header-handler-test-secret" };
const MODES = {
  direct_loopback: getAuthConfig({ ...SECRET, AIQSA_APP_BASE_URL: "http://localhost:3000" }),
  direct_peer: getAuthConfig({ ...SECRET, AIQSA_APP_BASE_URL: "http://10.20.30.40:3000", AIQSA_BIND_ADDRESS: "0.0.0.0" }),
  invalid: getAuthConfig({ ...SECRET, AIQSA_TRUST_PROXY_HEADERS: "true", AIQSA_BIND_ADDRESS: "0.0.0.0" }),
  trusted_proxy: getAuthConfig({ ...SECRET, AIQSA_APP_BASE_URL: "https://aiqsa.example", AIQSA_TRUST_PROXY_HEADERS: "true" })
};
const now = new Date("2026-10-08T12:00:00.000Z");
const EMAIL = "member@example.com";

const method: ResolvedSignInMethod<"trusted_header"> = {
  activeVersion: 3,
  config: trustedHeaderSignInConfigSchema.parse({
    allowedGroups: ["staff"],
    emailHeader: "X-Auth-Request-Email",
    groupsHeader: "X-Auth-Request-Groups",
    nameHeader: "X-Auth-Request-Preferred-Username"
  }),
  method: "trusted_header",
  secrets: {},
  source: "admin"
};

type SignInResult = Awaited<ReturnType<TrustedHeaderSignInRepository["signIn"]>>;

function sessionStore(records: Record<string, string> = {}) {
  const sessions = new Map<string, AuthSessionRecord>(Object.entries(records).map(([token, userId]) => [hashToken(token), {
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    id: `session-${userId}`,
    lastSeenAt: null,
    revokedAt: null,
    user: createTestUser({ id: userId, role: "user" }),
    userId
  }]));
  return {
    findSessionByTokenHash: vi.fn(async (tokenHash: string) => sessions.get(tokenHash) ?? null)
  } as unknown as AuthSessionStore;
}

function setup(input: {
  linked?: Record<string, string>;
  method?: ResolvedSignInMethod<"trusted_header"> | null;
  mode?: keyof typeof MODES;
  result?: SignInResult | Error;
  sessions?: Record<string, string>;
} = {}) {
  const repository = {
    findLinkedUserId: vi.fn<TrustedHeaderSignInRepository["findLinkedUserId"]>(async (email) => input.linked?.[email] ?? null),
    revokeReplacedSession: vi.fn<TrustedHeaderSignInRepository["revokeReplacedSession"]>(async () => true),
    signIn: vi.fn<TrustedHeaderSignInRepository["signIn"]>(async () => {
      const result = input.result ?? { sessionId: "new-session", status: "active", userId: "header-user" };
      if (result instanceof Error) throw result;
      return result;
    })
  } satisfies TrustedHeaderSignInRepository;
  const recordOutcome = vi.fn(async () => undefined);
  const limiter = createFixedWindowLoginRateLimiter({ maxAttempts: 2 });
  const handler = createTrustedHeaderSignInHandler({
    getConfig: () => MODES[input.mode ?? "trusted_proxy"],
    loginRateLimiter: limiter,
    now: () => now,
    recordOutcome,
    repository,
    resolveMethod: async () => (input.method === undefined ? method : input.method),
    sessions: sessionStore(input.sessions)
  });
  return { handler, limiter, recordOutcome, repository };
}

function request(input: { cookie?: string; headers?: Record<string, string>; next?: string } = {}) {
  const url = new URL("https://aiqsa.example/api/auth/trusted-header");
  if (input.next !== undefined) url.searchParams.set("next", input.next);
  return new Request(url, {
    headers: {
      "x-auth-request-email": EMAIL,
      "x-auth-request-groups": "staff,engineering",
      "x-forwarded-for": "198.51.100.7",
      ...(input.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${input.cookie}` } : {}),
      ...input.headers
    }
  });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location")!);
}

function sessionCookie(response: Response): string | undefined {
  return readCookie(response.headers.get("set-cookie"), SESSION_COOKIE_NAME);
}

describe("trusted-header sign-in route", () => {
  it("signs in the proxy's identity in trusted-proxy mode and returns to the safe next path", async () => {
    const { handler, recordOutcome, repository } = setup();

    const response = await handler(request({ next: "/c/chat-1?tab=files" }));

    expect(response.status).toBe(303);
    expect(location(response).toString()).toBe("https://aiqsa.example/c/chat-1?tab=files");
    expect(sessionCookie(response)).toEqual(expect.any(String));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(repository.signIn).toHaveBeenCalledWith({
      config: method.config,
      identity: { displayName: "", email: EMAIL, groups: ["staff", "engineering"] },
      now,
      session: expect.objectContaining({ tokenHash: hashToken(sessionCookie(response)!) })
    });
    expect(recordOutcome).toHaveBeenCalledWith(method, "accepted");
  });

  it.each(["direct_loopback", "direct_peer", "invalid"] as const)(
    "never reads the headers in %s mode",
    async (mode) => {
      expect(MODES[mode].clientIdentityMode).toBe(mode);
      const { handler, recordOutcome, repository } = setup({ mode });

      const response = await handler(request({ next: "/admin" }));

      expect(location(response).pathname).toBe("/login");
      expect(location(response).searchParams.get("trusted_header")).toBe("unavailable");
      expect(location(response).searchParams.get("next")).toBe("/admin");
      expect(sessionCookie(response)).toBeUndefined();
      expect(repository.signIn).not.toHaveBeenCalled();
      expect(repository.findLinkedUserId).not.toHaveBeenCalled();
      expect(recordOutcome).not.toHaveBeenCalled();
    }
  );

  it("is unavailable while the method is off", async () => {
    const { handler, repository } = setup({ method: null });

    const response = await handler(request());

    expect(location(response).searchParams.get("trusted_header")).toBe("unavailable");
    expect(repository.signIn).not.toHaveBeenCalled();
  });

  it("sends a request without the email header back to the login page with `missing`", async () => {
    const { handler, recordOutcome, repository } = setup();

    const response = await handler(request({ headers: { "x-auth-request-email": "" } }));

    expect(location(response).searchParams.get("trusted_header")).toBe("missing");
    expect(recordOutcome).toHaveBeenCalledWith(method, "header_missing");
    expect(repository.signIn).not.toHaveBeenCalled();
  });

  it.each([
    ["an oversized email", { "x-auth-request-email": `${"a".repeat(320)}@example.com` }],
    ["oversized groups", { "x-auth-request-groups": "g,".repeat(2_100) }],
    ["a control character", { "x-auth-request-email": "member\t@example.com" }]
  ])("refuses %s without touching accounts", async (_case, headers) => {
    const { handler, recordOutcome, repository } = setup();

    const response = await handler(request({ headers }));

    expect(location(response).searchParams.get("trusted_header")).toBe("invalid");
    expect(recordOutcome).toHaveBeenCalledWith(method, "header_invalid");
    expect(repository.signIn).not.toHaveBeenCalled();
    expect(sessionCookie(response)).toBeUndefined();
  });

  it("keeps a session of the header's own account without signing in again", async () => {
    const { handler, repository } = setup({ linked: { [EMAIL]: "header-user" }, sessions: { "own-token": "header-user" } });

    const response = await handler(request({ cookie: "own-token", next: "/admin" }));

    expect(location(response).toString()).toBe("https://aiqsa.example/admin");
    expect(sessionCookie(response)).toBeUndefined();
    expect(repository.revokeReplacedSession).not.toHaveBeenCalled();
    expect(repository.signIn).not.toHaveBeenCalled();
  });

  it("revokes a session of another account and signs in the header's user", async () => {
    const { handler, repository } = setup({ linked: { [EMAIL]: "header-user" }, sessions: { "other-token": "other-user" } });

    const response = await handler(request({ cookie: "other-token" }));

    expect(repository.revokeReplacedSession).toHaveBeenCalledWith({ now, tokenHash: hashToken("other-token") });
    expect(repository.signIn).toHaveBeenCalledTimes(1);
    expect(location(response).toString()).toBe("https://aiqsa.example/");
    expect(sessionCookie(response)).not.toBe("other-token");
    expect(sessionCookie(response)).toEqual(expect.any(String));
  });

  it("revokes another account's session even when the header's identity is refused", async () => {
    const { handler, recordOutcome, repository } = setup({
      result: { status: "not_allowed" },
      sessions: { "other-token": "other-user" }
    });

    const response = await handler(request({ cookie: "other-token" }));

    expect(repository.revokeReplacedSession).toHaveBeenCalledTimes(1);
    expect(location(response).searchParams.get("trusted_header")).toBe("not_allowed");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(recordOutcome).toHaveBeenCalledWith(method, "not_allowed");
  });

  it("shows a pending account as pending and records it as accepted", async () => {
    const { handler, recordOutcome } = setup({ result: { status: "pending" } });

    const response = await handler(request());

    expect(location(response).searchParams.get("trusted_header")).toBe("pending");
    expect(sessionCookie(response)).toBeUndefined();
    expect(recordOutcome).toHaveBeenCalledWith(method, "accepted");
  });

  it("ends a failed settlement as `failed` with a content-free health code", async () => {
    const { handler, recordOutcome } = setup({ result: new Error("database unavailable") });

    const response = await handler(request());

    expect(location(response).searchParams.get("trusted_header")).toBe("failed");
    expect(recordOutcome).toHaveBeenCalledWith(method, "sign_in_failed");
  });

  it("never redirects outside the installation", async () => {
    const { handler } = setup();

    const response = await handler(request({ next: "https://attacker.example/" }));

    expect(location(response).toString()).toBe("https://aiqsa.example/");
  });

  it("limits refused attempts per client and fails closed without the proxy's client address", async () => {
    const { handler } = setup({ result: { status: "not_allowed" } });

    await handler(request());
    await handler(request());
    const limited = await handler(request());
    expect(limited.headers.get("retry-after")).toEqual(expect.any(String));
    expect(location(limited).searchParams.get("trusted_header")).toBe("failed");

    const anonymous = await setup().handler(request({ headers: { "x-forwarded-for": "" } }));
    expect(location(anonymous).searchParams.get("trusted_header")).toBe("failed");
  });
});

describe("trusted-header admin probe", () => {
  const admin = createTestAuth();
  const member = createTestAuth({ token: "member-token", user: { role: "user" } });

  function probe(mode: keyof typeof MODES, input: { cookie?: string; emailHeader?: string; headers?: Record<string, string> }) {
    const url = new URL("https://aiqsa.example/api/admin/sign-in/trusted-header");
    if (input.emailHeader !== undefined) url.searchParams.set("emailHeader", input.emailHeader);
    const handler = createAdminTrustedHeaderProbeHandler({
      getConfig: () => MODES[mode],
      resolveAuth: async (req) => (await admin.resolveAuth(req)) ?? member.resolveAuth(req)
    });
    return handler(new Request(url, {
      headers: { ...(input.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${input.cookie}` } : {}), ...input.headers }
    }));
  }

  it("is for administrators only", async () => {
    expect((await probe("trusted_proxy", {})).status).toBe(401);
    expect((await probe("trusted_proxy", { cookie: member.token })).status).toBe(403);
  });

  it("shows the mode and the header's domain, never the address", async () => {
    const response = await probe("direct_peer", {
      cookie: admin.token,
      emailHeader: "Remote-Email",
      headers: { "remote-email": "Operator@Example.com" }
    });
    const body = await response.json();

    expect(body).toEqual({
      clientIdentityMode: "direct_peer",
      emailHeader: { domainHint: "@example.com", present: true, usable: true }
    });
    expect(JSON.stringify(body)).not.toContain("operator");
  });

  it("reports a missing or unusable header and needs no header name for the mode", async () => {
    await expect((await probe("trusted_proxy", { cookie: admin.token, emailHeader: "Remote-Email" })).json())
      .resolves.toEqual({ clientIdentityMode: "trusted_proxy", emailHeader: { domainHint: null, present: false, usable: false } });
    await expect((await probe("trusted_proxy", {
      cookie: admin.token,
      emailHeader: "Remote-Email",
      headers: { "remote-email": "not-an-email" }
    })).json()).resolves.toMatchObject({ emailHeader: { domainHint: null, present: true, usable: false } });
    await expect((await probe("trusted_proxy", { cookie: admin.token })).json())
      .resolves.toEqual({ clientIdentityMode: "trusted_proxy", emailHeader: null });
  });

  it("refuses an invalid header name", async () => {
    const response = await probe("trusted_proxy", { cookie: admin.token, emailHeader: "Bad Header" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "header_name_invalid" });
  });
});
