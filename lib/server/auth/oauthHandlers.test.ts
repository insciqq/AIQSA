// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "./config";
import {
  createOAuthCallbackHandler,
  createOAuthStartHandler,
  OAUTH_FLOW_COOKIE_NAME
} from "./oauthHandlers";
import type { OAuthIdentityRepository } from "./oauthRepository";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import { readCookie, SESSION_COOKIE_NAME } from "./session";
import { createMemoryAuthSessionStore, createTestUser } from "./testRequestAuth";

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
} = {}) {
  const provider = input.provider ?? "google";
  const values = ["code-verifier", "nonce", "state"];
  const response = await createOAuthStartHandler({
    getConfig: () => config,
    now: () => now,
    randomToken: () => values.shift()!
  })(
    new Request(
      `https://aiqsa.example/api/auth/oauth/${provider}?next=${encodeURIComponent(input.next ?? "/admin?tab=users")}`
    ),
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
      cookie: `${OAUTH_FLOW_COOKIE_NAME}=${input.flowToken}`,
      "user-agent": "OAuth handler test"
    }
  });
}

describe("OAuth route handlers", () => {
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
    const flow = await startFlow();
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
    const request = () => {
      const callback = callbackRequest({
        code: "authorization-code",
        flowToken: flow.flowToken,
        provider: "google",
        state: flow.location.searchParams.get("state")!
      });
      callback.headers.set("x-forwarded-for", "203.0.113.20");
      return callback;
    };

    const first = await handler(request(), {
      params: {
        provider: "google"
      }
    });
    const second = await handler(request(), {
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
