import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "./config";
import { createMemoryAuthMailer, createNoopAuthMailer } from "./mailer";
import { verifyPassword } from "./password";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import {
  createEmailVerificationHandler,
  createInviteAcceptanceHandler,
  createRegisterHandler,
  type EmailVerificationHandlerDeps
} from "./registrationHandlers";
import type {
  AcceptInviteInput,
  AuthRegistrationRepository,
  InviteAcceptanceResult,
  RegisterPasswordUserInput,
  RegistrationResult,
  VerificationResult
} from "./registrationRepository";
import { SESSION_COOKIE_NAME } from "./session";
import { hashToken } from "./token";

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://app.local${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });
}

const handlerConfig = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" });

function createMemoryRegistrationRepository(input: {
  acceptResult?: InviteAcceptanceResult | null;
  registerResult?: RegistrationResult;
  verifyResult?: VerificationResult | null;
} = {}): AuthRegistrationRepository & {
  acceptances: AcceptInviteInput[];
  registrations: RegisterPasswordUserInput[];
  verifications: Parameters<AuthRegistrationRepository["completeEmailVerification"]>[0][];
} {
  const acceptances: AcceptInviteInput[] = [];
  const registrations: RegisterPasswordUserInput[] = [];
  const verifications: Parameters<AuthRegistrationRepository["completeEmailVerification"]>[0][] = [];

  return {
    acceptances,
    registrations,
    verifications,
    async acceptInvite(acceptInput) {
      acceptances.push(acceptInput);
      return input.acceptResult === undefined ? { userId: "user-1" } : input.acceptResult;
    },
    async completeEmailVerification(verifyInput) {
      verifications.push(verifyInput);
      return input.verifyResult === undefined
        ? {
            source: "email_rule",
            status: "active",
            userId: "user-1"
          }
        : input.verifyResult;
    },
    async registerPasswordUser(registerInput) {
      registrations.push(registerInput);

      return input.registerResult === undefined
        ? {
            ok: true,
            sentToEmail: registerInput.normalizedEmail
          }
        : input.registerResult;
    }
  };
}

describe("registration auth handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts an invite with a password and returns an authenticated session cookie", async () => {
    const repository = createMemoryRegistrationRepository();
    const POST = createInviteAcceptanceHandler({
      getConfig: () =>
        getAuthConfig({
          AIQSA_APP_BASE_URL: "https://aiqsa.example",
          AIQSA_COOKIE_SECURE: "1",
          AIQSA_AUTH_SESSION_SECRET: "test-secret"
        }),
      now: () => new Date("2026-07-17T00:00:00.000Z"),
      repository
    });
    const request = jsonRequest("/api/auth/invite/accept", {
      displayName: "Invited User",
      password: "invited-password",
      token: "raw-invite-token"
    });
    request.headers.set("user-agent", "Invite Browser");

    const response = await POST(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "active" });
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(repository.acceptances).toHaveLength(1);
    expect(repository.acceptances[0]).toMatchObject({
      displayName: "Invited User",
      inviteTokenHash: hashToken("raw-invite-token"),
      session: {
        createdByUserAgent: "Invite Browser"
      }
    });
    expect(repository.acceptances[0]!.session.tokenHash).not.toBe("raw-invite-token");
    await expect(verifyPassword("invited-password", repository.acceptances[0]!.passwordHash)).resolves.toBe(true);
  });

  it("rejects invalid invite acceptance without setting a session cookie", async () => {
    const repository = createMemoryRegistrationRepository({ acceptResult: null });
    const POST = createInviteAcceptanceHandler({
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/invite/accept", {
        password: "invited-password",
        token: "expired-invite"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_invite_token" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("requires a valid password before invite acceptance", async () => {
    const repository = createMemoryRegistrationRepository();
    const POST = createInviteAcceptanceHandler({
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      repository
    });

    const missing = await POST(jsonRequest("/api/auth/invite/accept", { token: "invite" }));
    const short = await POST(
      jsonRequest("/api/auth/invite/accept", {
        password: "short",
        token: "invite"
      })
    );

    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "invite_token_password_required" });
    expect(short.status).toBe(400);
    await expect(short.json()).resolves.toEqual({ error: "password_too_short" });
    expect(repository.acceptances).toHaveLength(0);
  });

  it("registers an email request without a password and sends a verification link", async () => {
    const repository = createMemoryRegistrationRepository();
    const mailer = createMemoryAuthMailer();
    const POST = createRegisterHandler({
      getConfig: () =>
        getAuthConfig({
          AIQSA_APP_BASE_URL: "https://aiqsa.example",
          AIQSA_AUTH_SESSION_SECRET: "test-secret"
        }),
      mailer,
      now: () => new Date("2026-06-14T00:00:00.000Z"),
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/register", {
        displayName: "New User",
        email: " New.User@Example.COM "
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "request_received"
    });
    expect(repository.registrations).toHaveLength(1);
    expect(repository.registrations[0]).toMatchObject({
      displayName: "New User",
      normalizedEmail: "new.user@example.com"
    });
    expect(repository.registrations[0]).not.toHaveProperty("passwordHash");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain("https://aiqsa.example/login?verify=");
  });

  it("returns the same generic accepted response for new and already-verified eligible emails", async () => {
    const newRepository = createMemoryRegistrationRepository();
    const existingRepository = createMemoryRegistrationRepository({
      registerResult: {
        ok: true,
        sentToEmail: null
      }
    });
    const mailer = createMemoryAuthMailer();
    const config = getAuthConfig({
      AIQSA_APP_BASE_URL: "https://aiqsa.example",
      AIQSA_AUTH_SESSION_SECRET: "test-secret"
    });
    const newPOST = createRegisterHandler({
      getConfig: () => config,
      mailer,
      repository: newRepository
    });
    const existingPOST = createRegisterHandler({
      getConfig: () => config,
      mailer,
      repository: existingRepository
    });

    const newResponse = await newPOST(
      jsonRequest("/api/auth/register", {
        email: "new.user@example.com"
      })
    );
    const existingResponse = await existingPOST(
      jsonRequest("/api/auth/register", {
        email: "existing.user@example.com"
      })
    );

    expect(newResponse.status).toBe(200);
    expect(existingResponse.status).toBe(200);
    await expect(newResponse.json()).resolves.toEqual({ status: "request_received" });
    await expect(existingResponse.json()).resolves.toEqual({ status: "request_received" });
  });

  it("rejects invalid invite tokens without sending mail", async () => {
    const repository = createMemoryRegistrationRepository({
      registerResult: {
        error: "invalid_invite_token",
        ok: false
      }
    });
    const mailer = createMemoryAuthMailer();
    const POST = createRegisterHandler({
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      mailer,
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/register", {
        email: "new.user@example.com",
        inviteToken: "bad-invite"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_invite_token"
    });
    expect(mailer.sent).toHaveLength(0);
  });

  it("rejects disallowed registration without sending mail", async () => {
    const repository = createMemoryRegistrationRepository({
      registerResult: {
        error: "registration_not_allowed",
        ok: false
      }
    });
    const mailer = createMemoryAuthMailer();
    const POST = createRegisterHandler({
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      mailer,
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/register", {
        email: "typo@example.test"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "registration_not_allowed"
    });
    expect(mailer.sent).toHaveLength(0);
  });

  it("reports unavailable verification mail without claiming delivery", async () => {
    const repository = createMemoryRegistrationRepository();
    const POST = createRegisterHandler({
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      mailer: {
        async send() {
          return { kind: "unavailable" } as const;
        }
      },
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/register", {
        email: "allowed@example.com"
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "verification_email_unavailable"
    });
  });

  it("reports verification mail send failures", async () => {
    const repository = createMemoryRegistrationRepository();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const POST = createRegisterHandler({
      getConfig: () => getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" }),
      mailer: {
        async send() {
          return { code: "smtp_tls_failed", kind: "failed" } as const;
        }
      },
      repository
    });

    const response = await POST(
      jsonRequest("/api/auth/register", {
        email: "allowed@example.com"
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "verification_email_failed"
    });
    expect(errorLog).toHaveBeenCalledWith("verification_email_failed", expect.any(Error));
  });

  it("returns active and pending verification states", async () => {
    const active = createEmailVerificationHandler({
      getConfig: () => handlerConfig,
      repository: createMemoryRegistrationRepository({
        verifyResult: {
          source: "domain_rule",
          status: "active",
          userId: "user-1"
        }
      })
    } satisfies EmailVerificationHandlerDeps);
    const pending = createEmailVerificationHandler({
      getConfig: () => handlerConfig,
      repository: createMemoryRegistrationRepository({
        verifyResult: {
          source: null,
          status: "pending",
          userId: "user-2"
        }
      })
    });

    await expect(
      (await active(jsonRequest("/api/auth/verify-email", { password: "chosen-password", token: "verify" }))).json()
    ).resolves.toEqual({
      status: "active"
    });
    await expect(
      (await pending(jsonRequest("/api/auth/verify-email", { password: "other-password", token: "verify" }))).json()
    ).resolves.toEqual({
      status: "pending"
    });

  });

  it("rejects invalid or replayed verification tokens", async () => {
    const POST = createEmailVerificationHandler({
      getConfig: () => handlerConfig,
      repository: createMemoryRegistrationRepository({
        verifyResult: null
      })
    });

    const response = await POST(
      jsonRequest("/api/auth/verify-email", { password: "chosen-password", token: "expired" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_or_expired_verification_token"
    });
  });

  it("requires and hashes a new password at verification time", async () => {
    const repository = createMemoryRegistrationRepository();
    const POST = createEmailVerificationHandler({
      getConfig: () => handlerConfig,
      repository
    });

    const missingPassword = await POST(jsonRequest("/api/auth/verify-email", { token: "verify" }));
    expect(missingPassword.status).toBe(400);
    await expect(missingPassword.json()).resolves.toEqual({
      error: "verification_token_password_required"
    });
    expect(repository.verifications).toHaveLength(0);

    const response = await POST(
      jsonRequest("/api/auth/verify-email", { password: "chosen-password", token: "verify" })
    );
    expect(response.status).toBe(200);
    expect(repository.verifications).toHaveLength(1);
    await expect(
      verifyPassword("chosen-password", repository.verifications[0]!.passwordHash)
    ).resolves.toBe(true);
  });

  it("keeps successful registration attempts in the account bucket", async () => {
    const repository = createMemoryRegistrationRepository();
    const mailer = createMemoryAuthMailer();
    const POST = createRegisterHandler({
      getConfig: () => handlerConfig,
      mailer,
      registrationRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => 0,
        maxAttempts: 2
      }),
      repository
    });

    for (let index = 0; index < 2; index += 1) {
      expect(
        (
          await POST(
            jsonRequest("/api/auth/register", {
              email: "new.user@example.com"
            })
          )
        ).status
      ).toBe(200);
    }

    const blocked = await POST(
      jsonRequest("/api/auth/register", {
        email: "new.user@example.com"
      })
    );

    expect(blocked.status).toBe(429);
    expect(repository.registrations).toHaveLength(2);
    expect(mailer.sent).toHaveLength(2);
  });

  it("rate-limits the same verification token before additional password hashing", async () => {
    const passwordHasher = vi.fn(async () => "password-hash");
    const POST = createEmailVerificationHandler({
      getConfig: () => handlerConfig,
      passwordHasher,
      repository: createMemoryRegistrationRepository({ verifyResult: null }),
      verificationRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => 0,
        maxAttempts: 1
      })
    });

    expect(
      (
        await POST(
          jsonRequest("/api/auth/verify-email", {
            password: "chosen-password",
            token: "first-invalid-token"
          })
        )
      ).status
    ).toBe(400);
    expect(
      (
        await POST(
          jsonRequest("/api/auth/verify-email", {
            password: "chosen-password",
            token: "first-invalid-token"
          })
        )
      ).status
    ).toBe(429);
    expect(passwordHasher).toHaveBeenCalledTimes(1);
  });

  it("shares verification-token admission across trusted client keys", async () => {
    const passwordHasher = vi.fn(async () => "password-hash");
    const POST = createEmailVerificationHandler({
      getConfig: () => ({
        ...handlerConfig,
        trustForwardedFor: true,
        trustedProxyCount: 1
      }),
      passwordHasher,
      repository: createMemoryRegistrationRepository({ verifyResult: null }),
      verificationRateLimiter: createFixedWindowLoginRateLimiter({
        clock: () => 0,
        maxAttempts: 1
      })
    });
    const firstRequest = jsonRequest("/api/auth/verify-email", {
      password: "chosen-password",
      token: "shared-invalid-token"
    });
    const secondRequest = jsonRequest("/api/auth/verify-email", {
      password: "chosen-password",
      token: "shared-invalid-token"
    });
    firstRequest.headers.set("x-forwarded-for", "198.51.100.10");
    secondRequest.headers.set("x-forwarded-for", "198.51.100.11");

    expect((await POST(firstRequest)).status).toBe(400);
    expect((await POST(secondRequest)).status).toBe(429);
    expect(passwordHasher).toHaveBeenCalledTimes(1);
  });
});
