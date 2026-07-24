import { describe, expect, it, vi } from "vitest";
import { getAuthConfig, TEST_AUTH_TOKEN } from "./config";
import {
  createLogoutHandler,
  createMeHandler,
  createMessageAccessValidationHandler,
  createPasswordLoginHandler,
  createPasswordResetCompleteHandler,
  createPasswordResetRequestHandler,
  createTokenLoginHandler,
  getLoginRateLimitKey,
  type SafeUserWithGroups
} from "./handlers";
import { createMemoryAuthMailer } from "./mailer";
import { hashPassword, verifyPassword } from "./password";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import { createAuthSession } from "./requestAuth";
import { readCookie, SESSION_COOKIE_NAME } from "./session";
import { hashToken } from "./token";
import {
  createMemoryAuthSessionStore,
  createMemoryPasswordAuthRepository,
  createTestAuth,
  createTestPasswordIdentity
} from "./testRequestAuth";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
  AIQSA_AUTH_SESSION_SECRET: "test-secret"
});

const user: SafeUserWithGroups = {
  displayName: "Local Operator",
  email: "operator@aiqsa.local",
  groups: [
    {
      groupId: "group-1",
      name: "private-operators",
      role: "owner"
    }
  ],
  id: config.bootstrapUserId,
  role: "admin",
  status: "active"
};

function tokenRequest(token: string, options: { headers?: Record<string, string>; ip?: string } = {}): Request {
  const request = new Request("http://app.local/api/auth/token", {
    body: JSON.stringify({ token }),
    headers: {
      ...options.headers,
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (options.ip) {
    Object.defineProperty(request, "ip", {
      value: options.ip
    });
  }

  return request;
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://app.local${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

describe("auth route handlers", () => {
  it("creates a session cookie for a valid bootstrap token", async () => {
    const sessions = createMemoryAuthSessionStore({ user });
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => config,
      sessions
    });

    const response = await POST(tokenRequest(TEST_AUTH_TOKEN));
    const token = readCookie(response.headers.get("set-cookie"), SESSION_COOKIE_NAME);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("aiqsa_session=");
    expect(token).toBeTruthy();
    expect(sessions.records.has(hashToken(token!))).toBe(true);
  });

  it("rejects an invalid bootstrap token before user lookup", async () => {
    const findUserById = vi.fn(async () => user);
    const POST = createTokenLoginHandler({
      findUserById,
      getConfig: () => config,
      sessions: createMemoryAuthSessionStore({ user })
    });
    const wrongToken = await POST(tokenRequest("not-the-test-token"));

    expect(wrongToken.status).toBe(401);
    expect(findUserById).not.toHaveBeenCalled();
  });

  it("adds Secure to login cookies when configured", async () => {
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => ({
        ...config,
        cookieSecure: true
      }),
      sessions: createMemoryAuthSessionStore({ user })
    });

    const response = await POST(tokenRequest(TEST_AUTH_TOKEN));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects non-JSON token posts", async () => {
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => config,
      sessions: createMemoryAuthSessionStore({ user })
    });
    const response = await POST(
      new Request("http://app.local/api/auth/token", {
        body: "token=wrong",
        headers: {
          "content-type": "text/plain"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "json_required"
    });
  });

  it("keeps the bootstrap token route hidden when recovery login is disabled", async () => {
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => ({
        ...config,
        bootstrapConfigured: false,
        bootstrapLoginEnabled: false,
        bootstrapTokenHash: ""
      }),
      sessions: createMemoryAuthSessionStore({ user })
    });
    const response = await POST(tokenRequest(TEST_AUTH_TOKEN));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found"
    });
  });

  it("creates a session cookie for verified email/password credentials", async () => {
    const passwordHash = await hashPassword("correct-password");
    const repository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity({ passwordHash })
    });
    const POST = createPasswordLoginHandler({
      getConfig: () => ({
        ...config,
        bootstrapConfigured: false,
        bootstrapTokenHash: ""
      }),
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/login", {
        email: " Operator@AIQSA.Local ",
        password: "correct-password"
      })
    );
    const token = readCookie(response.headers.get("set-cookie"), SESSION_COOKIE_NAME);

    expect(response.status).toBe(200);
    expect(token).toBeTruthy();
    expect(repository.loginSessions.has(hashToken(token!))).toBe(true);
  });

  it("rejects invalid, inactive, and unverified password credentials generically", async () => {
    const passwordHash = await hashPassword("correct-password");
    const inactiveRepository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity({
        passwordHash,
        user: {
          status: "disabled"
        }
      })
    });
    const unverifiedRepository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity({
        emailVerifiedAt: null,
        passwordHash
      })
    });

    for (const repository of [inactiveRepository, unverifiedRepository]) {
      const POST = createPasswordLoginHandler({
        getConfig: () => config,
        repository,
        verifyPassword: async () => true
      });
      const response = await POST(
        jsonRequest("/api/auth/login", {
          email: "operator@aiqsa.local",
          password: "correct-password"
        })
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "unauthorized"
      });
    }
  });

  it("runs password verification for missing and ineligible identities to avoid timing oracles", async () => {
    const missingRepository = createMemoryPasswordAuthRepository({
      identity: null
    });
    const disabledRepository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity({
        passwordHash: await hashPassword("correct-password"),
        user: {
          status: "disabled"
        }
      })
    });
    const verifyPasswordCalls: [string, string | null | undefined][] = [];
    const verifyPasswordMock = vi.fn(async (password: string, passwordHash: string | null | undefined) => {
      verifyPasswordCalls.push([password, passwordHash]);

      return false;
    });

    for (const repository of [missingRepository, disabledRepository]) {
      const POST = createPasswordLoginHandler({
        getConfig: () => config,
        repository,
        verifyPassword: verifyPasswordMock
      });
      const response = await POST(
        jsonRequest("/api/auth/login", {
          email: "operator@aiqsa.local",
          password: "wrong-password"
        })
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "unauthorized"
      });
    }

    expect(verifyPasswordMock).toHaveBeenCalledTimes(2);
    expect(verifyPasswordCalls.every(([, passwordHash]) => typeof passwordHash === "string")).toBe(true);
  });

  it("rate-limits password sprays across many distinct emails from one client bucket", async () => {
    const loginRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => 0
    });
    const repository = createMemoryPasswordAuthRepository({
      identity: null
    });
    const POST = createPasswordLoginHandler({
      getConfig: () => config,
      loginRateLimiter,
      repository,
      verifyPassword: async () => false
    });

    for (let index = 0; index < 10; index += 1) {
      const response = await POST(
        jsonRequest("/api/auth/login", {
          email: `spray-${index}@aiqsa.local`,
          password: "wrong-password"
        })
      );
      expect(response.status).toBe(401);
    }

    const blocked = await POST(
      jsonRequest("/api/auth/login", {
        email: "spray-11@aiqsa.local",
        password: "wrong-password"
      })
    );

    expect(blocked.status).toBe(429);
  });

  it("creates and emails one-time password reset tokens without revealing unknown accounts", async () => {
    const repository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity()
    });
    const mailer = createMemoryAuthMailer();
    const POST = createPasswordResetRequestHandler({
      getConfig: () => ({
        ...config,
        appBaseUrl: "https://aiqsa.example"
      }),
      mailer,
      now: () => new Date("2026-06-14T00:00:00.000Z"),
      repository,
      responseFloorMs: 0
    });

    const response = await POST(
      jsonRequest("/api/auth/password-reset/request", {
        email: "operator@aiqsa.local"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(repository.resetTokens.size).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain("https://aiqsa.example/login?reset=");

    repository.identity = null;
    const unknownResponse = await POST(
      jsonRequest("/api/auth/password-reset/request", {
        email: "missing@aiqsa.local"
      })
    );

    expect(unknownResponse.status).toBe(200);
    await expect(unknownResponse.json()).resolves.toEqual({ ok: true });
    expect(mailer.sent).toHaveLength(1);
  });

  it("keeps reset responses on the same floor without awaiting SMTP for known accounts", async () => {
    const pendingMail = deferred();
    const sleep = vi.fn(async () => undefined);
    const knownRepository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity()
    });
    const unknownRepository = createMemoryPasswordAuthRepository({ identity: null });
    const mailer = {
      send: vi.fn(() => pendingMail.promise)
    };
    const deps = {
      clock: () => 1_000,
      getConfig: () => ({
        ...config,
        appBaseUrl: "https://aiqsa.example"
      }),
      mailer,
      responseFloorMs: 75,
      sleep
    };

    try {
      const knownResponse = await createPasswordResetRequestHandler({
        ...deps,
        repository: knownRepository
      })(
        jsonRequest("/api/auth/password-reset/request", {
          email: "operator@aiqsa.local"
        })
      );
      const unknownResponse = await createPasswordResetRequestHandler({
        ...deps,
        repository: unknownRepository
      })(
        jsonRequest("/api/auth/password-reset/request", {
          email: "missing@aiqsa.local"
        })
      );

      expect(knownResponse.status).toBe(200);
      expect(unknownResponse.status).toBe(200);
      expect(sleep).toHaveBeenNthCalledWith(1, 75);
      expect(sleep).toHaveBeenNthCalledWith(2, 75);
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(knownRepository.resetTokens.size).toBe(1);
    } finally {
      pendingMail.resolve();
    }
  });

  it("sets a password from a reset token, consumes sibling tokens, and rejects replay", async () => {
    const repository = createMemoryPasswordAuthRepository({
      identity: createTestPasswordIdentity()
    });
    await repository.createPasswordResetToken({
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      identityId: repository.identity!.id,
      normalizedEmail: repository.identity!.normalizedEmail,
      sentToEmail: repository.identity!.normalizedEmail,
      tokenHash: hashToken("reset-token"),
      userId: user.id
    });
    await repository.createPasswordResetToken({
      expiresAt: new Date("2026-06-14T01:00:00.000Z"),
      identityId: repository.identity!.id,
      normalizedEmail: repository.identity!.normalizedEmail,
      sentToEmail: repository.identity!.normalizedEmail,
      tokenHash: hashToken("sibling-reset-token"),
      userId: user.id
    });
    const POST = createPasswordResetCompleteHandler({
      getConfig: () => config,
      now: () => new Date("2026-06-14T00:05:00.000Z"),
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/password-reset/complete", {
        password: "new-password",
        token: "reset-token"
      })
    );

    expect(response.status).toBe(200);
    await expect(verifyPassword("new-password", repository.identity?.passwordHash)).resolves.toBe(true);
    expect([...repository.resetTokens.values()].every((token) => token.consumedAt)).toBe(true);

    const replay = await POST(
      jsonRequest("/api/auth/password-reset/complete", {
        password: "newer-password",
        token: "reset-token"
      })
    );

    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({
      error: "invalid_or_expired_reset_token"
    });
  });

  it("rate-limits reset completion before additional password hashing", async () => {
    const passwordHasher = vi.fn(async () => "password-hash");
    const POST = createPasswordResetCompleteHandler({
      getConfig: () => config,
      passwordHasher,
      repository: createMemoryPasswordAuthRepository({ identity: null }),
      resetCompleteRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => 0,
        maxAttempts: 1
      })
    });

    const first = await POST(
      jsonRequest("/api/auth/password-reset/complete", {
        password: "new-password",
        token: "first-invalid-token"
      })
    );
    const blocked = await POST(
      jsonRequest("/api/auth/password-reset/complete", {
        password: "new-password",
        token: "different-invalid-token"
      })
    );

    expect(first.status).toBe(400);
    expect(blocked.status).toBe(429);
    expect(passwordHasher).toHaveBeenCalledTimes(1);
  });

  it("shares reset-completion token admission across trusted client keys", async () => {
    const passwordHasher = vi.fn(async () => "password-hash");
    const POST = createPasswordResetCompleteHandler({
      getConfig: () => ({
        ...config,
        trustForwardedFor: true,
        trustedProxyCount: 1
      }),
      passwordHasher,
      repository: createMemoryPasswordAuthRepository({ identity: null }),
      resetCompleteRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => 0,
        maxAttempts: 1
      })
    });
    const firstRequest = jsonRequest("/api/auth/password-reset/complete", {
      password: "new-password",
      token: "shared-invalid-token"
    });
    const secondRequest = jsonRequest("/api/auth/password-reset/complete", {
      password: "new-password",
      token: "shared-invalid-token"
    });
    firstRequest.headers.set("x-forwarded-for", "198.51.100.10, 10.0.0.1");
    secondRequest.headers.set("x-forwarded-for", "198.51.100.11, 10.0.0.1");

    expect((await POST(firstRequest)).status).toBe(400);
    expect((await POST(secondRequest)).status).toBe(429);
    expect(passwordHasher).toHaveBeenCalledTimes(1);
  });

  it("rate-limits the 11th login attempt before token hash verification", async () => {
    const loginRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => 0
    });
    const verifyTokenHash = vi.fn(() => false);
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => config,
      loginRateLimiter,
      sessions: createMemoryAuthSessionStore({ user }),
      verifyTokenHash
    });

    for (let index = 0; index < 10; index += 1) {
      const response = await POST(tokenRequest("wrong-token", { ip: "203.0.113.20" }));
      expect(response.status).toBe(401);
    }

    const blocked = await POST(tokenRequest(TEST_AUTH_TOKEN, { ip: "203.0.113.20" }));

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    expect(verifyTokenHash).toHaveBeenCalledTimes(10);
  });

  it("rate-limits unknown-client wrong-token attempts independent of guessed token value", async () => {
    const loginRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => 0
    });
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => config,
      loginRateLimiter,
      sessions: createMemoryAuthSessionStore({ user }),
      verifyTokenHash: (token) => token === TEST_AUTH_TOKEN
    });

    for (let index = 0; index < 10; index += 1) {
      expect((await POST(tokenRequest(`wrong-token-${index}`))).status).toBe(401);
    }

    expect((await POST(tokenRequest(TEST_AUTH_TOKEN))).status).toBe(429);
  });

  it("resets the login rate limit after a successful login", async () => {
    const loginRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => 0
    });
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => config,
      loginRateLimiter,
      sessions: createMemoryAuthSessionStore({ user }),
      verifyTokenHash: (token) => token === TEST_AUTH_TOKEN
    });

    for (let index = 0; index < 9; index += 1) {
      const response = await POST(tokenRequest("wrong-token", { ip: "203.0.113.20" }));
      expect(response.status).toBe(401);
    }

    expect((await POST(tokenRequest(TEST_AUTH_TOKEN, { ip: "203.0.113.20" }))).status).toBe(200);

    for (let index = 0; index < 10; index += 1) {
      const response = await POST(tokenRequest("wrong-token", { ip: "203.0.113.20" }));
      expect(response.status).toBe(401);
    }

    expect((await POST(tokenRequest("wrong-token", { ip: "203.0.113.20" }))).status).toBe(429);
  });

  it("expires login rate limit windows", async () => {
    let now = 0;
    const loginRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => now
    });
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => config,
      loginRateLimiter,
      sessions: createMemoryAuthSessionStore({ user }),
      verifyTokenHash: () => false
    });

    for (let index = 0; index < 10; index += 1) {
      expect((await POST(tokenRequest("wrong-token"))).status).toBe(401);
    }

    expect((await POST(tokenRequest("wrong-token"))).status).toBe(429);

    now = 15 * 60 * 1000 + 1;

    expect((await POST(tokenRequest("wrong-token"))).status).toBe(401);
  });

  it("ignores synthetic peer IPs and uses trusted forwarded headers only when configured", () => {
    const request = tokenRequest("wrong-token", {
      headers: {
        "x-forwarded-for": "198.51.100.9, 10.0.0.1",
        "x-real-ip": "198.51.100.10"
      },
      ip: "203.0.113.20"
    });

    expect(getLoginRateLimitKey(request, false)).toBe("unknown-client");
    expect(getLoginRateLimitKey(request, true, 1)).toBe("ip:198.51.100.9");
  });

  it("uses rightmost untrusted forwarded IPs only when trusted", () => {
    const request = new Request("http://app.local/api/auth/token", {
      headers: {
        "x-forwarded-for": "198.51.100.250, 203.0.113.10, 10.0.0.1",
        "x-real-ip": "203.0.113.11"
      }
    });

    expect(getLoginRateLimitKey(request, false)).toBe("unknown-client");
    expect(getLoginRateLimitKey(request, true, 1)).toBe("ip:203.0.113.10");
    expect(getLoginRateLimitKey(request, true, 2)).toBe("ip:198.51.100.250");
  });

  it("falls back to trusted real IP when forwarded-for has no untrusted hop", () => {
    const request = new Request("http://app.local/api/auth/token", {
      headers: {
        "x-forwarded-for": "10.0.0.1",
        "x-real-ip": "203.0.113.11"
      }
    });

    expect(getLoginRateLimitKey(request, true, 1)).toBe("ip:203.0.113.11");
  });

  it("does not let varied leftmost forwarded values bypass a trusted-hop client bucket", async () => {
    const loginRateLimiter = createFixedWindowLoginRateLimiter({
      clock: () => 0
    });
    const POST = createTokenLoginHandler({
      findUserById: async () => user,
      getConfig: () => ({
        ...config,
        trustForwardedFor: true,
        trustedProxyCount: 1
      }),
      loginRateLimiter,
      sessions: createMemoryAuthSessionStore({ user }),
      verifyTokenHash: () => false
    });

    for (let index = 0; index < 10; index += 1) {
      const response = await POST(
        tokenRequest("wrong-token", {
          headers: {
            "x-forwarded-for": `198.51.100.${index}, 203.0.113.10, 10.0.0.1`
          }
        })
      );
      expect(response.status).toBe(401);
    }

    const blocked = await POST(
      tokenRequest("wrong-token", {
        headers: {
          "x-forwarded-for": "198.51.100.250, 203.0.113.10, 10.0.0.1"
        }
      })
    );

    expect(blocked.status).toBe(429);
  });

  it("rejects inactive bootstrap users", async () => {
    const POST = createTokenLoginHandler({
      findUserById: async () => ({
        ...user,
        status: "disabled"
      }),
      getConfig: () => config,
      sessions: createMemoryAuthSessionStore({ user })
    });

    const response = await POST(tokenRequest(TEST_AUTH_TOKEN));

    expect(response.status).toBe(401);
  });

  it("clears secure logout cookies for JSON logout posts", async () => {
    const sessions = createMemoryAuthSessionStore({ user });
    const created = await createAuthSession({
      secureCookie: true,
      sessions,
      userId: user.id
    });
    const POST = createLogoutHandler({
      getConfig: () => ({
        cookieSecure: true
      }),
      sessions
    });
    const response = await POST(
      new Request("http://app.local/api/auth/logout", {
        body: "{}",
        headers: {
          cookie: created.cookie,
          "content-type": "application/json"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(sessions.records.get(hashToken(created.token))?.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects non-JSON logout posts", async () => {
    const POST = createLogoutHandler({
      getConfig: () => ({
        cookieSecure: false
      }),
      sessions: createMemoryAuthSessionStore({ user })
    });
    const response = await POST(
      new Request("http://app.local/api/auth/logout", {
        body: "",
        headers: {
          "content-type": "text/plain"
        },
        method: "POST"
      })
    );

    expect(response.status).toBe(415);
  });

  it("rejects anonymous /api/me requests", async () => {
    const auth = createTestAuth({ user });
    const GET = createMeHandler({
      findUserWithGroups: async () => user,
      resolveAuth: auth.resolveAuth
    });

    const response = await GET(new Request("http://app.local/api/me"));

    expect(response.status).toBe(401);
  });

  it("returns safe user and group metadata for a valid session", async () => {
    const auth = createTestAuth({ user });
    const GET = createMeHandler({
      findUserWithGroups: async () => user,
      resolveAuth: auth.resolveAuth
    });
    const response = await GET(
      new Request("http://app.local/api/me", {
        headers: {
          cookie: auth.cookie
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user
    });
  });

  it("rejects unavailable model access in the backend message route", async () => {
    const auth = createTestAuth({ user });
    const POST = createMessageAccessValidationHandler({
      findOwnedChat: async () => ({ id: "chat-1" }),
      loadEntitlements: async () => ({
        modelKeys: new Set(["openai:gpt-5.5"]),
        providerKeys: new Set(),
        searchStrategies: new Set(["openai-native-web-search"])
      }),
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/chats/chat-1/messages", {
        body: JSON.stringify({
          modelId: "claude-opus-4-8",
          provider: "anthropic"
        }),
        headers: {
          cookie: auth.cookie
        },
        method: "POST"
      }),
      {
        params: {
          chatId: "chat-1"
        }
      }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "model_not_available"
    });
  });
});
