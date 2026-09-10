// @vitest-environment node

import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "./config";
import {
  createOAuthCallbackHandler,
  createOAuthStartHandler,
  OAUTH_FLOW_COOKIE_NAME
} from "./oauthHandlers";
import type { OAuthIdentityRepository } from "./oauthRepository";
import { type exchangeOAuthCode } from "./oauthProviders";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import { createAuthSession, resolveAuthToken } from "./requestAuth";
import { readCookie, SESSION_COOKIE_NAME } from "./session";
import { createMemoryAuthSessionStore, createTestUser } from "@/tests/support/auth";

const config = getAuthConfig({
  AIQSA_APP_BASE_URL: "https://aiqsa.example",
  AIQSA_COOKIE_SECURE: "1",
  AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client",
  AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
  AIQSA_YANDEX_OAUTH_CLIENT_ID: "yandex-client",
  AIQSA_YANDEX_OAUTH_CLIENT_SECRET: "yandex-secret",
  AIQSA_AUTH_SESSION_SECRET: "oauth-handler-test-secret",
  AIQSA_TRUST_PROXY_HEADERS: "1",
  AIQSA_TRUSTED_PROXY_COUNT: "1"
});
const now = new Date("2026-07-18T12:00:00.000Z");

function repository(status: "account_conflict" | "active" | "not_allowed" | "pending" = "active") {
  const settleIdentity = vi.fn<OAuthIdentityRepository["settleIdentity"]>(async () =>
    status === "active"
      ? {
          status,
          userId: "oauth-user"
        }
      : {
          status
        }
  );

  return {
    repository: {
      settleIdentity
    } satisfies OAuthIdentityRepository,
    settleIdentity
  };
}

async function startFlow(input: {
  next?: string;
  provider?: "google" | "yandex";
  seed?: string;
  switchAccount?: boolean;
} = {}) {
  const provider = input.provider ?? "google";
  const suffix = input.seed ? `-${input.seed}` : "";
  const values = [`code-verifier${suffix}`, `nonce${suffix}`, `state${suffix}`];
  const url = new URL(`https://aiqsa.example/api/auth/oauth/${provider}`);
  url.searchParams.set("next", input.next ?? "/admin?tab=users");
  if (input.switchAccount) {
    url.searchParams.set("switch_account", "1");
  }
  const response = await createOAuthStartHandler({
    getConfig: () => config,
    now: () => now,
    randomToken: () => values.shift()!
  })(
    new Request(url),
    {
      params: {
        provider
      }
    }
  );
  const location = new URL(response.headers.get("location")!);
  const flowToken = readCookie(response.headers.get("set-cookie"), OAUTH_FLOW_COOKIE_NAME)!;

  return {
    flowToken,
    location,
    provider,
    response
  };
}

function callbackRequest(input: {
  code?: string;
  error?: string;
  flowToken: string;
  provider: "google" | "yandex";
  sessionCookie?: string;
  state: string;
}): Request {
  const url = new URL(`https://aiqsa.example/api/auth/oauth/${input.provider}/callback`);
  url.searchParams.set("state", input.state);

  if (input.code) {
    url.searchParams.set("code", input.code);
  }

  if (input.error) {
    url.searchParams.set("error", input.error);
  }

  return new Request(url, {
    headers: {
      cookie: [
        `${OAUTH_FLOW_COOKIE_NAME}=${input.flowToken}`,
        input.sessionCookie
      ].filter(Boolean).join("; "),
      "user-agent": "OAuth handler test"
    }
  });
}

describe("OAuth route handlers", () => {
  it.each([
    ["yandex", "", null],
    ["yandex", "switch_account=1", "yes"],
    ["yandex", "switch_account=true", null],
    ["yandex", "switch_account=1&switch_account=1", null],
    ["yandex", "force_confirm=yes&prompt=select_account&login_hint=private-account", null],
    ["google", "switch_account=1", null]
  ] as const)("accepts only explicit Yandex switching: %s ?%s", async (provider, query, forceConfirm) => {
    const response = await createOAuthStartHandler({ getConfig: () => config })(
      new Request(`https://aiqsa.example/api/auth/oauth/${provider}?${query}&client_id=untrusted&redirect_uri=https://evil.example`),
      { params: { provider } }
    );
    const location = new URL(response.headers.get("location")!);

    expect(location.searchParams.get("force_confirm")).toBe(forceConfirm);
    expect(location.searchParams.get("client_id")).toBe(`${provider}-client`);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `https://aiqsa.example/api/auth/oauth/${provider}/callback`
    );
    expect(location.searchParams.has("switch_account")).toBe(false);
    expect(location.searchParams.has("prompt")).toBe(false);
    expect(location.searchParams.has("login_hint")).toBe(false);
  });

  it("replaces an existing Yandex flow with fresh signed state, nonce, and PKCE when switching", async () => {
    const handler = createOAuthStartHandler({ getConfig: () => config, now: () => now });
    const context = { params: { provider: "yandex" } };
    const first = await handler(new Request("https://aiqsa.example/api/auth/oauth/yandex"), context);
    const firstToken = readCookie(first.headers.get("set-cookie"), OAUTH_FLOW_COOKIE_NAME)!;
    const nextPath = "/admin?tab=users#section";
    const second = await handler(
      new Request(`https://aiqsa.example/api/auth/oauth/yandex?switch_account=1&next=${encodeURIComponent(nextPath)}`, {
        headers: { cookie: `${OAUTH_FLOW_COOKIE_NAME}=${firstToken}` }
      }),
      context
    );
    const secondToken = readCookie(second.headers.get("set-cookie"), OAUTH_FLOW_COOKIE_NAME)!;
    const verifyOptions = { algorithms: ["HS256"], currentDate: now };
    const secret = new TextEncoder().encode(config.sessionSecret);
    const firstFlow = (await jwtVerify(firstToken, secret, verifyOptions)).payload;
    const secondFlow = (await jwtVerify(secondToken, secret, verifyOptions)).payload;
    const location = new URL(second.headers.get("location")!);

    expect(secondToken).not.toBe(firstToken);
    for (const field of ["state", "nonce", "codeVerifier"] as const) {
      expect(secondFlow[field]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secondFlow[field]).not.toBe(firstFlow[field]);
    }
    expect(secondFlow).toMatchObject({ nextPath, provider: "yandex" });
    expect(location.searchParams.get("force_confirm")).toBe("yes");
    expect(location.searchParams.get("state")).toBe(secondFlow.state);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(secondFlow.codeVerifier as string).digest("base64url")
    );
    expect(location.searchParams.get("redirect_uri")).toBe("https://aiqsa.example/api/auth/oauth/yandex/callback");
    expect(second.headers.getSetCookie()).toHaveLength(1);
    expect(second.headers.get("set-cookie")).toContain("HttpOnly");
    expect(second.headers.get("set-cookie")).toContain("Path=/api/auth/oauth");
    expect(second.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("starts a provider-bound PKCE flow in a short-lived secure HttpOnly cookie", async () => {
    const { location, response } = await startFlow();
    const cookie = response.headers.get("set-cookie")!;

    expect(response.status).toBe(303);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("state")).toBe("state");
    expect(location.searchParams.get("nonce")).toBe("nonce");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://aiqsa.example/api/auth/oauth/google/callback"
    );
    expect(location.searchParams.get("code_challenge")).not.toBe("code-verifier");
    expect(cookie).toContain(`${OAUTH_FLOW_COOKIE_NAME}=`);
    expect(cookie).toContain("Path=/api/auth/oauth");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("Secure");
  });

  it("merges the provider identity, creates the normal session, and restores the signed internal path", async () => {
    const flow = await startFlow();
    const sessions = createMemoryAuthSessionStore({
      user: createTestUser({
        id: "oauth-user"
      })
    });
    const repo = repository("active");
    const exchangeCode = vi.fn(async () => ({
      displayName: "OAuth User",
      email: " OAuth.User@Example.com ",
      providerAccountId: "provider-subject"
    }));
    const response = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => now,
      repository: repo.repository,
      sessions
    })(
      callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "google"
        }
      }
    );
    const setCookie = response.headers.get("set-cookie")!;
    const setCookies = response.headers.getSetCookie();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://aiqsa.example/admin?tab=users");
    expect(setCookie).toContain(`${OAUTH_FLOW_COOKIE_NAME}=`);
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookies).toHaveLength(2);
    expect(repo.settleIdentity).toHaveBeenCalledWith({
      displayName: "OAuth User",
      email: "oauth.user@example.com",
      now,
      provider: "google",
      providerAccountId: "provider-subject"
    });
    expect(sessions.records.size).toBe(1);
  });

  it.each(["active", "pending", "not_allowed", "account_conflict"] as const)(
    "keeps admission authoritative when rejected Yandex account A switches to account B: %s",
    async (secondStatus) => {
      const nextPath = "/admin?tab=users#section";
      const firstFlow = await startFlow({ next: nextPath, provider: "yandex", seed: "account-a" });
      const sessions = createMemoryAuthSessionStore({ user: createTestUser({ id: "admitted-user-b" }) });
      const createSession = vi.spyOn(sessions, "createSession");
      const settleIdentity = vi.fn<OAuthIdentityRepository["settleIdentity"]>(async ({ providerAccountId }) => {
        if (providerAccountId === "yandex-account-a") return { status: "not_allowed" };
        return secondStatus === "active"
          ? { status: "active", userId: "admitted-user-b" }
          : { status: secondStatus };
      });
      const exchangeCode = vi.fn<typeof exchangeOAuthCode>(async ({ code }) => ({
        displayName: "Yandex User",
        email: `${code}@example.com`,
        providerAccountId: `yandex-${code}`
      }));
      const handler = createOAuthCallbackHandler({
        exchangeCode,
        getConfig: () => config,
        now: () => now,
        repository: { settleIdentity },
        sessions
      });
      const context = { params: { provider: "yandex" } };
      const first = await handler(callbackRequest({
        code: "account-a",
        flowToken: firstFlow.flowToken,
        provider: "yandex",
        state: firstFlow.location.searchParams.get("state")!
      }), context);
      const recovery = new URL(first.headers.get("location")!);

      expect(recovery.searchParams.get("oauth")).toBe("not_allowed");
      expect(recovery.searchParams.get("provider")).toBe("yandex");
      expect(recovery.searchParams.get("next")).toBe(nextPath);
      expect(first.headers.getSetCookie()).toEqual([
        expect.stringContaining(`${OAUTH_FLOW_COOKIE_NAME}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0`)
      ]);
      expect(createSession).not.toHaveBeenCalled();
      expect(sessions.records.size).toBe(0);

      const secondFlow = await startFlow({
        next: recovery.searchParams.get("next")!,
        provider: "yandex",
        seed: "account-b",
        switchAccount: true
      });
      const second = await handler(callbackRequest({
        code: "account-b",
        flowToken: secondFlow.flowToken,
        provider: "yandex",
        state: secondFlow.location.searchParams.get("state")!
      }), context);

      expect(secondFlow.location.searchParams.get("force_confirm")).toBe("yes");
      expect(secondFlow.flowToken).not.toBe(firstFlow.flowToken);
      expect(exchangeCode).toHaveBeenNthCalledWith(2, expect.objectContaining({
        code: "account-b",
        codeVerifier: "code-verifier-account-b",
        provider: "yandex"
      }));
      expect(settleIdentity).toHaveBeenNthCalledWith(1, {
        displayName: "Yandex User", email: "account-a@example.com", now,
        provider: "yandex", providerAccountId: "yandex-account-a"
      });
      expect(settleIdentity).toHaveBeenNthCalledWith(2, {
        displayName: "Yandex User", email: "account-b@example.com", now,
        provider: "yandex", providerAccountId: "yandex-account-b"
      });
      if (secondStatus === "active") {
        expect(second.headers.get("location")).toBe(`https://aiqsa.example${nextPath}`);
        expect(createSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "admitted-user-b" }));
        expect([...sessions.records.values()].map((session) => session.userId)).toEqual(["admitted-user-b"]);
        expect(second.headers.getSetCookie()).toHaveLength(2);
      } else {
        const outcome = new URL(second.headers.get("location")!);
        expect(outcome.searchParams.get("oauth")).toBe(secondStatus);
        expect(outcome.searchParams.get("next")).toBe(nextPath);
        expect(createSession).not.toHaveBeenCalled();
        expect(sessions.records.size).toBe(0);
        expect(second.headers.getSetCookie()).toHaveLength(1);
      }
      expect(second.headers.get("set-cookie")).toContain(`${OAUTH_FLOW_COOKIE_NAME}=;`);
      expect(second.headers.get("location")).not.toContain("yandex-account");
      expect(second.headers.get("location")).not.toContain("@example.com");
    }
  );

  it.each([
    "missing-flow", "invalid-flow", "expired-flow", "mismatched-state", "mismatched-provider",
    "cancelled", "provider-error", "exchange-failed"
  ] as const)("preserves the existing session when a switched Yandex attempt ends with %s", async (failure) => {
    const flow = await startFlow({ provider: "yandex", seed: failure, switchAccount: true });
    const sessions = createMemoryAuthSessionStore({ user: createTestUser({ id: "existing-user" }) });
    const existingSession = await createAuthSession({
      now, secureCookie: true, sessions, userId: "existing-user"
    });
    const createSession = vi.spyOn(sessions, "createSession");
    const revokeSession = vi.spyOn(sessions, "revokeSessionByTokenHash");
    const repo = repository();
    const exchangeCode = vi.fn(async () => {
      throw new Error("private provider response and account identifier");
    });
    const provider = failure === "mismatched-provider" ? "google" : "yandex";
    const rejectedBeforeExchange = failure !== "exchange-failed";
    const invalidFlow = ["missing-flow", "invalid-flow", "expired-flow", "mismatched-state", "mismatched-provider"].includes(failure);
    const response = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => failure === "expired-flow" ? new Date(now.getTime() + 11 * 60 * 1000) : now,
      repository: repo.repository,
      sessions
    })(callbackRequest({
      code: failure === "cancelled" || failure === "provider-error" ? undefined : "code",
      error: failure === "cancelled" ? "access_denied" : failure === "provider-error" ? "private-provider-error" : undefined,
      flowToken: failure === "missing-flow" ? "" : failure === "invalid-flow" ? "invalid-token" : flow.flowToken,
      provider,
      sessionCookie: `${SESSION_COOKIE_NAME}=${existingSession.token}`,
      state: failure === "mismatched-state" ? "wrong-state" : flow.location.searchParams.get("state")!
    }), { params: { provider } });
    const outcome = new URL(response.headers.get("location")!);

    expect(outcome.origin).toBe("https://aiqsa.example");
    expect(outcome.pathname).toBe("/login");
    expect(outcome.searchParams.get("oauth")).toBe(failure === "cancelled" ? "cancelled" : "failed");
    expect(outcome.searchParams.get("next")).toBe(invalidFlow ? null : "/admin?tab=users");
    expect(outcome.searchParams.get("provider")).toBe(provider);
    expect([...outcome.searchParams.keys()].sort()).toEqual(invalidFlow ? ["oauth", "provider"] : ["next", "oauth", "provider"]);
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringContaining(`${OAUTH_FLOW_COOKIE_NAME}=; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=0`)
    ]);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(exchangeCode).toHaveBeenCalledTimes(rejectedBeforeExchange ? 0 : 1);
    expect(repo.settleIdentity).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
    expect(sessions.records.size).toBe(1);
    await expect(resolveAuthToken(existingSession.token, { now, sessions })).resolves.toMatchObject({ userId: "existing-user" });
  });

  it.each(["https://evil.example/steal", "//evil.example/steal", "/%5cevil.example", "/\\evil.example", "/bad path"])(
    "does not carry unsafe next through account switching: %s",
    async (next) => {
      const flow = await startFlow({ next, provider: "yandex", switchAccount: true });
      const response = await createOAuthCallbackHandler({
        getConfig: () => config,
        now: () => now,
        repository: repository().repository,
        sessions: createMemoryAuthSessionStore()
      })(callbackRequest({
        error: "access_denied",
        flowToken: flow.flowToken,
        provider: "yandex",
        state: flow.location.searchParams.get("state")!
      }), { params: { provider: "yandex" } });

      expect(flow.location.searchParams.get("force_confirm")).toBe("yes");
      expect(response.headers.get("location")).toBe("https://aiqsa.example/login?oauth=cancelled&provider=yandex");
    }
  );

  it("fails a direct OAuth callback closed before provider exchange without a launcher stamp", async () => {
    const flow = await startFlow();
    const exchangeCode = vi.fn();
    const repo = repository();
    const response = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () =>
        getAuthConfig({
          AIQSA_APP_BASE_URL: "http://192.168.10.4:3000",
          AIQSA_AUTH_SESSION_SECRET: "oauth-handler-test-secret",
          AIQSA_BIND_ADDRESS: "0.0.0.0",
          AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client",
          AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret"
        }),
      now: () => now,
      repository: repo.repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "google"
        }
      }
    );

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(repo.settleIdentity).not.toHaveBeenCalled();
  });

  it("fails an exposed trusted-proxy topology before provider exchange", async () => {
    const flow = await startFlow();
    const exchangeCode = vi.fn();
    const repo = repository();
    const response = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () =>
        getAuthConfig({
          AIQSA_APP_BASE_URL: "https://aiqsa.example",
          AIQSA_AUTH_SESSION_SECRET: "oauth-handler-test-secret",
          AIQSA_BIND_ADDRESS: "0.0.0.0",
          AIQSA_GOOGLE_OAUTH_CLIENT_ID: "google-client",
          AIQSA_GOOGLE_OAUTH_CLIENT_SECRET: "google-secret",
          AIQSA_TRUST_PROXY_HEADERS: "1"
        }),
      now: () => now,
      repository: repo.repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      }),
      { params: { provider: "google" } }
    );

    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(repo.settleIdentity).not.toHaveBeenCalled();
  });

  it("rate-limits repeated valid callback exchanges before another provider request", async () => {
    const firstFlow = await startFlow({ seed: "client-first" });
    const secondFlow = await startFlow({ seed: "client-second" });
    const repo = repository();
    const exchangeCode = vi.fn(async () => {
      throw new Error("provider rejected code");
    });
    const handler = createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      loginRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => now.getTime(),
        maxAttempts: 1
      }),
      now: () => now,
      repository: repo.repository,
      sessions: createMemoryAuthSessionStore()
    });
    const request = (flow: Awaited<ReturnType<typeof startFlow>>) => {
      const callback = callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      });
      callback.headers.set("x-forwarded-for", "203.0.113.20");
      return callback;
    };

    const first = await handler(request(firstFlow), {
      params: {
        provider: "google"
      }
    });
    const second = await handler(request(secondFlow), {
      params: {
        provider: "google"
      }
    });

    expect(new URL(first.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(first.headers.get("retry-after")).toBeNull();
    expect(new URL(second.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(second.headers.get("retry-after")).toBe("900");
    expect(exchangeCode).toHaveBeenCalledTimes(1);
    expect(repo.settleIdentity).not.toHaveBeenCalled();
  });

  it("gives concurrent handlers one durable winner for the same signed flow", async () => {
    const flow = await startFlow({ seed: "race" });
    const flowRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => now.getTime(),
      maxAttempts: 1,
      windowMs: 10 * 60 * 1000
    });
    const providerRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => now.getTime(),
      maxAttempts: 60,
      windowMs: 10 * 60 * 1000
    });
    const exchangeCode = vi.fn(async () => {
      throw new Error("ambiguous provider failure");
    });
    const makeHandler = () => createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => now,
      oauthFlowRateLimiter: flowRateLimiter,
      oauthProviderRateLimiter: providerRateLimiter,
      repository: repository().repository,
      sessions: createMemoryAuthSessionStore()
    });
    const request = () => callbackRequest({
      code: "authorization-code",
      flowToken: flow.flowToken,
      provider: "google",
      state: flow.location.searchParams.get("state")!
    });

    const responses = await Promise.all([
      makeHandler()(request(), { params: { provider: "google" } }),
      makeHandler()(request(), { params: { provider: "google" } })
    ]);

    expect(exchangeCode).toHaveBeenCalledTimes(1);
    for (const response of responses) {
      expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    }
    expect(responses.filter((response) => response.headers.has("retry-after"))).toHaveLength(1);
  });

  it("bounds provider exchanges across fresh flows without a client identity bucket", async () => {
    const flows = await Promise.all([
      startFlow({ seed: "provider-one" }),
      startFlow({ seed: "provider-two" }),
      startFlow({ seed: "provider-three" })
    ]);
    const exchangeCode = vi.fn(async () => {
      throw new Error("provider rejected code");
    });
    const handler = createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => now,
      oauthFlowRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => now.getTime(),
        maxAttempts: 1,
        windowMs: 10 * 60 * 1000
      }),
      oauthProviderRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => now.getTime(),
        maxAttempts: 2,
        windowMs: 10 * 60 * 1000
      }),
      repository: repository().repository,
      sessions: createMemoryAuthSessionStore()
    });

    const responses = [];
    for (const flow of flows) {
      responses.push(await handler(callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      }), { params: { provider: "google" } }));
    }

    expect(exchangeCode).toHaveBeenCalledTimes(2);
    expect(responses[2]?.headers.get("retry-after")).toBe("600");
    expect(new URL(responses[2]!.headers.get("location")!).searchParams.get("oauth")).toBe(
      "failed"
    );
  });

  it("derives the flow admission key without exposing signed proof material", async () => {
    const flow = await startFlow({ seed: "key-material" });
    const flowChecks = vi.fn(async (_key: string) => ({ allowed: true, retryAfterSeconds: 0 }));
    const providerChecks = vi.fn(async (_key: string) => ({ allowed: true, retryAfterSeconds: 0 }));
    const handler = createOAuthCallbackHandler({
      exchangeCode: async () => {
        throw new Error("stop after admission");
      },
      getConfig: () => config,
      now: () => now,
      oauthFlowRateLimiter: { check: flowChecks, reset: vi.fn() },
      oauthProviderRateLimiter: { check: providerChecks, reset: vi.fn() },
      repository: repository().repository,
      sessions: createMemoryAuthSessionStore()
    });
    const state = flow.location.searchParams.get("state")!;

    await handler(callbackRequest({
      code: "authorization-code",
      flowToken: flow.flowToken,
      provider: "google",
      state
    }), { params: { provider: "google" } });

    expect(flowChecks).toHaveBeenCalledOnce();
    const flowKey = flowChecks.mock.calls[0]?.[0];
    expect(flowKey).toMatch(/^oauth-callback:google:flow:[a-f0-9]{64}$/);
    expect(flowKey).not.toContain(flow.flowToken);
    expect(flowKey).not.toContain(state);
    expect(providerChecks).toHaveBeenCalledWith("oauth-callback:google:installation");
  });

  it("rejects tampered state before exchanging a code and clears the flow cookie", async () => {
    const flow = await startFlow();
    const exchangeCode = vi.fn();
    const repo = repository();
    const response = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => now,
      repository: repo.repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: "tampered-state"
      }),
      {
        params: {
          provider: "google"
        }
      }
    );

    expect(new URL(response.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(repo.settleIdentity).not.toHaveBeenCalled();
  });

  it("rejects expired and cross-provider flow cookies before code exchange", async () => {
    const expiredFlow = await startFlow();
    const exchangeCode = vi.fn();
    const repo = repository();
    const expired = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => new Date(now.getTime() + 11 * 60 * 1000),
      repository: repo.repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "code",
        flowToken: expiredFlow.flowToken,
        provider: "google",
        state: expiredFlow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "google"
        }
      }
    );
    const mixedFlow = await startFlow();
    const mixed = await createOAuthCallbackHandler({
      exchangeCode,
      getConfig: () => config,
      now: () => now,
      repository: repo.repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "code",
        flowToken: mixedFlow.flowToken,
        provider: "yandex",
        state: mixedFlow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "yandex"
        }
      }
    );

    expect(new URL(expired.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(new URL(mixed.headers.get("location")!).searchParams.get("oauth")).toBe("failed");
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(repo.settleIdentity).not.toHaveBeenCalled();
  });

  it("keeps an unconfigured provider route hidden", async () => {
    const response = await createOAuthStartHandler({
      getConfig: () => ({
        ...config,
        oauthProviders: {}
      })
    })(new Request("https://aiqsa.example/api/auth/oauth/google"), {
      params: {
        provider: "google"
      }
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("maps provider cancellation and pending admission to clean login outcomes", async () => {
    const cancelledFlow = await startFlow();
    const cancelled = await createOAuthCallbackHandler({
      getConfig: () => config,
      now: () => now,
      repository: repository().repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        error: "access_denied",
        flowToken: cancelledFlow.flowToken,
        provider: "google",
        state: cancelledFlow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "google"
        }
      }
    );
    const pendingFlow = await startFlow({ provider: "yandex" });
    const pending = await createOAuthCallbackHandler({
      exchangeCode: async () => ({
        displayName: "Pending User",
        email: "pending@example.com",
        providerAccountId: "pending-subject"
      }),
      getConfig: () => config,
      now: () => now,
      repository: repository("pending").repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "code",
        flowToken: pendingFlow.flowToken,
        provider: "yandex",
        state: pendingFlow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "yandex"
        }
      }
    );

    expect(new URL(cancelled.headers.get("location")!).searchParams.get("oauth")).toBe("cancelled");
    expect(new URL(pending.headers.get("location")!).searchParams.get("oauth")).toBe("pending");
  });

  it("does not carry an external next destination through the signed flow", async () => {
    const flow = await startFlow({
      next: "https://evil.example/steal"
    });
    const response = await createOAuthCallbackHandler({
      exchangeCode: async () => ({
        displayName: "OAuth User",
        email: "user@example.com",
        providerAccountId: "subject"
      }),
      getConfig: () => config,
      now: () => now,
      repository: repository("active").repository,
      sessions: createMemoryAuthSessionStore()
    })(
      callbackRequest({
        code: "code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      }),
      {
        params: {
          provider: "google"
        }
      }
    );

    expect(response.headers.get("location")).toBe("https://aiqsa.example/");
  });
});
