// @vitest-environment node

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oidcSignInConfigSchema, type AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { createFakeOidcProvider, type FakeOidcProvider } from "@/tests/support/fakeOidcProvider";
import { createMemoryAuthSessionStore, createTestUser } from "@/tests/support/auth";
import { getAuthConfig } from "../config";
import type { ExternalSignInResult } from "../externalIdentity";
import { createLogoutHandler } from "../handlers";
import {
  createOAuthCallbackHandler,
  createOAuthStartHandler,
  OAUTH_FLOW_COOKIE_NAME,
  type ResolvedOAuthProvider
} from "../oauthHandlers";
import { createFixedWindowLoginRateLimiter } from "../rateLimit";
import { createAuthSession } from "../requestAuth";
import { readCookie, SESSION_COOKIE_NAME } from "../session";
import { hashToken } from "../token";
import { createOidcClient } from "./oidcClient";
import { oidcAutoRedirectPath } from "./oidcLoginRedirect";
import { createOidcSignInFlow, oidcLogoutRedirect, type OidcSettlement } from "./oidcSignIn";

const config = getAuthConfig({
  AIQSA_APP_BASE_URL: "https://aiqsa.example",
  AIQSA_AUTH_SESSION_SECRET: "oidc-handler-test-secret",
  AIQSA_COOKIE_SECURE: "1",
  AIQSA_TRUST_PROXY_HEADERS: "1",
  AIQSA_TRUSTED_PROXY_COUNT: "1"
});
const now = new Date("2026-10-08T12:00:00.000Z");
let clientOrdinal = 0;

let idp: FakeOidcProvider;

function sessionCookie(response: Response): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    const value = readCookie(cookie.split(";")[0] ?? null, SESSION_COOKIE_NAME);
    if (value) return value;
  }
  return null;
}

function oidcConfig(overrides: Partial<AuthSignInMethodConfig<"oidc">> = {}) {
  return oidcSignInConfigSchema.parse({
    adminGroups: ["/admins"],
    allowedGroups: ["/staff"],
    clientId: idp.clientId,
    issuer: idp.issuer,
    ...overrides
  });
}

function harness(input: {
  config?: AuthSignInMethodConfig<"oidc">;
  settlement?: Awaited<ReturnType<OidcSettlement>>;
} = {}) {
  const settle = vi.fn<OidcSettlement>(async () => input.settlement ?? ({ sessionId: "session-1", status: "active", userId: "user-1" } satisfies ExternalSignInResult));
  const recordOutcome = vi.fn(async (_code: string) => undefined);
  const resolved: ResolvedOAuthProvider = {
    flow: createOidcSignInFlow({
      client: createOidcClient({ fetchImpl: idp.fetch, now: () => now.getTime() }),
      config: input.config ?? oidcConfig(),
      secrets: { clientSecret: idp.clientSecret },
      settle
    }),
    recordOutcome
  };
  const resolveProvider = vi.fn(async (provider: string) => (provider === "oidc" ? resolved : null));
  const values = ["code-verifier-value", "nonce-value", "state-value"];
  const start = createOAuthStartHandler({ getConfig: () => config, now: () => now, randomToken: () => values.shift()!, resolveProvider });
  const callback = createOAuthCallbackHandler({
    getConfig: () => config,
    loginRateLimiter: createFixedWindowLoginRateLimiter(),
    now: () => now,
    oauthFlowRateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 1, windowMs: 600_000 }),
    oauthProviderRateLimiter: createFixedWindowLoginRateLimiter({ maxAttempts: 600, windowMs: 600_000 }),
    repository: { settleIdentity: vi.fn(async () => { throw new Error("google_yandex_only"); }) },
    resolveProvider,
    sessions: createMemoryAuthSessionStore()
  });
  return { callback, recordOutcome, settle, start };
}

async function run(h: ReturnType<typeof harness>, query: { code?: string; error?: string } = { code: "valid-code" }) {
  const started = await h.start(new Request("https://aiqsa.example/api/auth/oauth/oidc?next=%2Fprojects"), { params: { provider: "oidc" } });
  const location = new URL(started.headers.get("location")!);
  const flowToken = readCookie(started.headers.get("set-cookie"), OAUTH_FLOW_COOKIE_NAME)!;
  idp.state.nonce = location.searchParams.get("nonce") ?? "";
  const url = new URL("https://aiqsa.example/api/auth/oauth/oidc/callback");
  url.searchParams.set("state", location.searchParams.get("state") ?? "");
  if (query.code) url.searchParams.set("code", query.code);
  if (query.error) url.searchParams.set("error", query.error);
  const response = await h.callback(
    new Request(url, {
      headers: {
        cookie: `${OAUTH_FLOW_COOKIE_NAME}=${flowToken}`,
        "user-agent": "OIDC test",
        "x-forwarded-for": `2001:db8:${(++clientOrdinal).toString(16)}::1`
      }
    }),
    { params: { provider: "oidc" } }
  );
  return { location, response, started };
}

beforeEach(async () => {
  idp = await createFakeOidcProvider({ now: () => now });
});

describe("OIDC through the OAuth start and callback", () => {
  it("redirects to the provider with PKCE S256, state and nonce, then settles and issues an oidc session", async () => {
    const h = harness();
    const { location, response, started } = await run(h);

    expect(started.status).toBe(303);
    expect(location.searchParams.get("code_challenge")).toBe(createHash("sha256").update("code-verifier-value").digest("base64url"));
    expect(location.searchParams.get("state")).toBe("state-value");
    expect(location.searchParams.get("redirect_uri")).toBe("https://aiqsa.example/api/auth/oauth/oidc/callback");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://aiqsa.example/projects");
    expect(sessionCookie(response)).toBeTruthy();
    expect(h.recordOutcome).toHaveBeenCalledWith("accepted");

    const settlement = h.settle.mock.calls[0]![0];
    expect(settlement).toMatchObject({
      displayName: "Person Example",
      email: "person@example.test",
      emailVerified: true,
      groups: ["/staff"],
      policy: {
        adminGroups: ["/admins"],
        admission: { allowedGroups: ["/staff"], kind: "groups" },
        autoCreateUsers: true,
        syncGroups: true,
        trustUnverifiedEmail: false
      },
      provider: "oidc",
      signInMethod: "oidc",
      source: idp.issuer,
      subject: "subject-1"
    });
    // The session row stores only the token hash of the cookie it sets.
    const token = sessionCookie(response)!;
    expect(settlement.session.tokenHash).toBe(hashToken(token));
  });

  it.each(["account_conflict", "email_missing", "not_allowed", "source_changed"] as const)(
    "shows the %s outcome and records it as health",
    async (status) => {
      const h = harness({ settlement: { status } });
      const { response } = await run(h);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("oauth")).toBe(status);
      expect(location.searchParams.get("provider")).toBe("oidc");
      expect(sessionCookie(response)).toBeFalsy();
      expect(h.recordOutcome).toHaveBeenCalledWith(status);
    }
  );

  it("records a pending account as accepted", async () => {
    const h = harness({ settlement: { status: "pending" } });
    const { response } = await run(h);
    expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("pending");
    expect(h.recordOutcome).toHaveBeenCalledWith("accepted");
  });

  it("fails a token that does not validate without settling, recording only a content-free code", async () => {
    idp.state.idTokenClaims = { aud: "another-client" };
    const h = harness();
    const { response } = await run(h);
    expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(h.settle).not.toHaveBeenCalled();
    expect(h.recordOutcome).toHaveBeenCalledWith("id_token_invalid");
    expect(JSON.stringify(h.recordOutcome.mock.calls)).not.toMatch(/fake-access-token|person@example|eyJ/u);
  });

  it("maps a provider error to cancelled without an exchange", async () => {
    const h = harness();
    const { response } = await run(h, { error: "access_denied" });
    expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("cancelled");
    expect(idp.state.requests.some((request) => request.route === "token")).toBe(false);
  });

  it("sends an unreachable provider back to the login page with a failure, not into a loop", async () => {
    idp.state.failures.discovery = "network";
    const h = harness();
    const started = await h.start(new Request("https://aiqsa.example/api/auth/oauth/oidc"), { params: { provider: "oidc" } });
    const location = new URL(started.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("oauth")).toBe("failed");
    expect(location.searchParams.get("provider")).toBe("oidc");
    expect(h.recordOutcome).toHaveBeenCalledWith("discovery_unreachable");
  });

  it("is unavailable while OIDC is off", async () => {
    const start = createOAuthStartHandler({ getConfig: () => config, resolveProvider: async () => null });
    const response = await start(new Request("https://aiqsa.example/api/auth/oauth/oidc"), { params: { provider: "oidc" } });
    expect(response.status).toBe(404);
  });
});

describe("OIDC auto-redirect", () => {
  const params = (value: Record<string, string>) => value;

  it("sends /login to the OIDC start with the next path", () => {
    expect(oidcAutoRedirectPath({ config: oidcConfig({ autoRedirect: true }), nextPath: "/projects?tab=a", params: {} }))
      .toBe("/api/auth/oauth/oidc?next=%2Fprojects%3Ftab%3Da");
  });

  it.each([
    ["auto-redirect is off", false, {}],
    ["?local=1 is present", true, { local: "1" }],
    ["an outcome is shown", true, { oauth: "failed", provider: "oidc" }],
    ["the session expired", true, { reason: "session_expired" }],
    ["an invitation link is open", true, { invite: "token" }],
    ["a password reset link is open", true, { reset: "token" }],
    ["an email verification link is open", true, { verify: "token" }]
  ])("stays on the login page when %s", (_name, autoRedirect, query) => {
    expect(oidcAutoRedirectPath({ config: oidcConfig({ autoRedirect }), nextPath: "/", params: params(query) })).toBeNull();
  });

  it("does nothing while OIDC is off", () => {
    expect(oidcAutoRedirectPath({ config: null, nextPath: "/", params: {} })).toBeNull();
  });
});

describe("OIDC IdP logout", () => {
  const user = createTestUser();

  async function logout(input: { config: AuthSignInMethodConfig<"oidc">; signInMethod: string }) {
    const sessions = createMemoryAuthSessionStore({ user });
    const created = await createAuthSession({ secureCookie: true, sessions, userId: user.id });
    sessions.records.get(hashToken(created.token))!.signInMethod = input.signInMethod;
    const client = createOidcClient({ fetchImpl: idp.fetch });
    const POST = createLogoutHandler({
      getConfig: () => ({ cookieSecure: true }),
      identityProviderLogout: async ({ signInMethod }) => {
        // The local session is already revoked when the IdP step runs.
        expect(sessions.records.get(hashToken(created.token))?.revokedAt).toBeInstanceOf(Date);
        return oidcLogoutRedirect({ appBaseUrl: "https://aiqsa.example", client, config: input.config, signInMethod });
      },
      sessions
    });
    const response = await POST(new Request("https://aiqsa.example/api/auth/logout", {
      body: "{}",
      headers: { "content-type": "application/json", cookie: created.cookie },
      method: "POST"
    }));
    return { response, revokedAt: sessions.records.get(hashToken(created.token))?.revokedAt };
  }

  it("revokes the session first, then answers with the end-session redirect", async () => {
    const { response, revokedAt } = await logout({ config: oidcConfig({ idpLogout: true }), signInMethod: "oidc" });
    expect(revokedAt).toBeInstanceOf(Date);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    const target = new URL(((await response.json()) as { redirectTo: string }).redirectTo);
    expect(`${target.origin}${target.pathname}`).toBe(`${idp.issuer}/protocol/openid-connect/logout`);
    expect(target.searchParams.get("client_id")).toBe(idp.clientId);
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe("https://aiqsa.example/login");
    expect(target.searchParams.has("id_token_hint")).toBe(false);
  });

  it("logs out locally only for other sign-in methods or with IdP logout off", async () => {
    for (const input of [
      { config: oidcConfig({ idpLogout: true }), signInMethod: "password" },
      { config: oidcConfig({ idpLogout: false }), signInMethod: "oidc" }
    ]) {
      const { response, revokedAt } = await logout(input);
      expect(revokedAt).toBeInstanceOf(Date);
      expect(response.status).toBe(204);
    }
  });

  it("keeps an auto-redirect installation on the login page after a local logout", async () => {
    const { response } = await logout({ config: oidcConfig({ autoRedirect: true }), signInMethod: "oidc" });
    expect(await response.json()).toEqual({ redirectTo: "https://aiqsa.example/login?local=1" });
  });

  it("still logs out locally when the provider is unreachable", async () => {
    idp.state.failures.discovery = "network";
    const { response, revokedAt } = await logout({ config: oidcConfig({ idpLogout: true }), signInMethod: "oidc" });
    expect(revokedAt).toBeInstanceOf(Date);
    expect(response.status).toBe(204);
  });
});
