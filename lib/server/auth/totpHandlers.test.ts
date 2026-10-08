// @vitest-environment node

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TwoFactorStatusWire } from "@/lib/contracts/twoFactor";
import { createMemoryPasswordAuthRepository, createTestAuth, createTestPasswordIdentity } from "@/tests/support/auth";
import { getAuthConfig } from "./config";
import { createPasswordLoginHandler } from "./handlers";
import type { PasswordAuthRepository } from "./passwordRepository";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import {
  createSecondFactorChallengeCookie,
  SECOND_FACTOR_COOKIE_NAME,
  type SecondFactorChallengeSubject
} from "./secondFactorChallenge";
import { SESSION_COOKIE_NAME } from "./session";
import { SecretEnvelopeError } from "../secrets/envelope";
import {
  createSecondFactorSignInHandler,
  createTwoFactorActionHandler,
  createTwoFactorStatusHandler,
  secondFactorAttemptFromBody,
  type TwoFactorHandlerDeps
} from "./totpHandlers";
import type { SecondFactorSignInRepository, TotpEnrolmentRepository } from "./totpRepository";

const config = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "totp-handler-secret" });
const proxyConfig = getAuthConfig({
  AIQSA_AUTH_SESSION_SECRET: "totp-handler-secret",
  AIQSA_TRUST_PROXY_HEADERS: "1",
  AIQSA_TRUSTED_PROXY_COUNT: "1"
});
const keys = { encryptionKey: randomBytes(32), recoveryCodeKey: randomBytes(32) };
const signedInUser = { displayName: "Ada", email: "ada@example.test", id: "user-1", role: "user", status: "active" };
const subject: SecondFactorChallengeSubject = {
  credential: "stored-password-hash",
  factorBinding: "1:2:0",
  identityId: "identity-1",
  signInMethod: "password",
  userId: "user-1"
};

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST"
  });
}

async function challengeCookie(input: Partial<SecondFactorChallengeSubject> = {}, now = new Date()): Promise<string> {
  const setCookie = await createSecondFactorChallengeCookie({ ...subject, ...input }, { config, now });

  return setCookie.split(";")[0]!;
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function signInRepository(
  complete: SecondFactorSignInRepository["completeSecondFactorSignIn"] = async () => ({ kind: "session", user: signedInUser })
) {
  const completeSecondFactorSignIn = vi.fn(complete);

  return { completeSecondFactorSignIn };
}

function secondFactorHandler(input: {
  complete?: SecondFactorSignInRepository["completeSecondFactorSignIn"];
  getKeys?: () => typeof keys;
  maxAttempts?: number;
  proxy?: boolean;
} = {}) {
  const repository = signInRepository(input.complete);
  const POST = createSecondFactorSignInHandler({
    getConfig: () => input.proxy ? proxyConfig : config,
    getKeys: input.getKeys ?? (() => keys),
    rateLimiter: createFixedWindowLoginRateLimiter({ clock: () => 0, maxAttempts: input.maxAttempts ?? 10 }),
    repository
  });

  return { POST, repository };
}

describe("password sign-in with two-factor", () => {
  it("answers a verified password of a user with TOTP with a challenge cookie and no session", async () => {
    const repository: PasswordAuthRepository = {
      ...createMemoryPasswordAuthRepository({ identity: createTestPasswordIdentity({ passwordHash: "hash" }) }),
      createSessionForCurrentPassword: async () => ({ challenge: subject, kind: "second_factor_required" })
    };
    const POST = createPasswordLoginHandler({
      getConfig: () => config,
      loginRateLimiter: createFixedWindowLoginRateLimiter(),
      repository,
      verifyPassword: async () => true
    });

    const response = await POST(jsonRequest("/api/auth/login", { email: "operator@aiqsa.local", password: "correct" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "second_factor_required" });
    expect(setCookies(response)).toHaveLength(1);
    expect(setCookies(response)[0]).toMatch(new RegExp(`^${SECOND_FACTOR_COOKIE_NAME}=.+; Path=/api/auth/second-factor; HttpOnly`, "u"));
    expect(setCookies(response)[0]).not.toContain(SESSION_COOKIE_NAME);
  });
});

describe("second-factor route", () => {
  it("redeems the challenge with a code: a session cookie, the challenge cleared", async () => {
    const { POST, repository } = secondFactorHandler();
    const response = await POST(jsonRequest("/api/auth/second-factor", { code: "123 456" }, { cookie: await challengeCookie() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: signedInUser });
    const cookies = setCookies(response);
    expect(cookies[0]).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=[^;]+; Path=/; HttpOnly`, "u"));
    expect(cookies[1]).toBe(`${SECOND_FACTOR_COOKIE_NAME}=; Path=/api/auth/second-factor; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect(response.headers.get("cache-control")).toContain("no-store");

    const call = repository.completeSecondFactorSignIn.mock.calls[0]![0];
    expect(call).toMatchObject({
      attempt: { code: "123 456", kind: "totp" },
      challenge: { identityId: "identity-1", signInMethod: "password", userId: "user-1" },
      keys
    });
    expect(call.session.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    // The repository re-checks the account against the challenge in its transaction.
    expect(call.matchesChallenge({ credential: subject.credential, factorBinding: subject.factorBinding })).toBe(true);
    expect(call.matchesChallenge({ credential: "changed-password-hash", factorBinding: subject.factorBinding })).toBe(false);
    expect(call.matchesChallenge({ credential: subject.credential, factorBinding: "1:3:0" })).toBe(false);
  });

  it("passes a recovery code as one", async () => {
    const { POST, repository } = secondFactorHandler();

    await POST(jsonRequest("/api/auth/second-factor", { recoveryCode: "ABCDE-FGHJK" }, { cookie: await challengeCookie() }));

    expect(repository.completeSecondFactorSignIn.mock.calls[0]![0].attempt).toEqual({ code: "ABCDE-FGHJK", kind: "recovery" });
  });

  it("refuses a missing, foreign or expired challenge before any database work", async () => {
    const { POST, repository } = secondFactorHandler();
    const expired = await challengeCookie({}, new Date(Date.now() - 301_000));
    const foreign = `${SECOND_FACTOR_COOKIE_NAME}=${(await createSecondFactorChallengeCookie(subject, {
      config: { cookieSecure: false, sessionSecret: "another-installation" },
      now: new Date()
    })).split(";")[0]!.split("=")[1]}`;

    for (const cookie of [undefined, expired, foreign]) {
      const response = await POST(jsonRequest("/api/auth/second-factor", { code: "123456" }, cookie ? { cookie } : {}));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "challenge_expired" });
      expect(setCookies(response)).toEqual([`${SECOND_FACTOR_COOKIE_NAME}=; Path=/api/auth/second-factor; HttpOnly; SameSite=Lax; Max-Age=0`]);
    }
    expect(repository.completeSecondFactorSignIn).not.toHaveBeenCalled();
  });

  it("keeps the challenge after a wrong code and drops it once the account changed", async () => {
    const invalid = secondFactorHandler({ complete: async () => ({ kind: "invalid_code" }) });
    const wrong = await invalid.POST(jsonRequest("/api/auth/second-factor", { code: "000000" }, { cookie: await challengeCookie() }));

    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: "invalid_code" });
    expect(setCookies(wrong)).toEqual([]);

    const stale = secondFactorHandler({ complete: async () => ({ kind: "challenge_expired" }) });
    const changed = await stale.POST(jsonRequest("/api/auth/second-factor", { code: "123456" }, { cookie: await challengeCookie() }));

    expect(changed.status).toBe(401);
    await expect(changed.json()).resolves.toEqual({ error: "challenge_expired" });
    expect(setCookies(changed)[0]).toContain("Max-Age=0");
  });

  it("needs exactly one code", async () => {
    const { POST, repository } = secondFactorHandler();
    const cookie = await challengeCookie();

    for (const body of [{}, { code: "" }, { code: "123456", recoveryCode: "ABCDE-FGHJK" }, { code: 123456 }]) {
      const response = await POST(jsonRequest("/api/auth/second-factor", body, { cookie }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "code_required" });
    }
    expect(repository.completeSecondFactorSignIn).not.toHaveBeenCalled();
    expect(secondFactorAttemptFromBody({ code: " 1 " })).toEqual({ code: " 1 ", kind: "totp" });
  });

  it("limits guesses per account across sources and per source", async () => {
    const { POST, repository } = secondFactorHandler({
      complete: async () => ({ kind: "invalid_code" }),
      maxAttempts: 2,
      proxy: true
    });
    const cookie = await challengeCookie();
    const attempt = (source: string) =>
      POST(jsonRequest("/api/auth/second-factor", { code: "000000" }, { cookie, "x-forwarded-for": source }));

    expect((await attempt("198.51.100.1")).status).toBe(401);
    expect((await attempt("198.51.100.2")).status).toBe(401);
    // The account's budget is spent, whichever source asks next.
    const limited = await attempt("198.51.100.3");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(repository.completeSecondFactorSignIn).toHaveBeenCalledTimes(2);

    const other = secondFactorHandler({ complete: async () => ({ kind: "invalid_code" }), maxAttempts: 2, proxy: true });
    const sourceAttempt = async (userId: string) =>
      other.POST(jsonRequest("/api/auth/second-factor", { code: "000000" }, {
        cookie: await challengeCookie({ userId }),
        "x-forwarded-for": "203.0.113.9"
      }));
    expect((await sourceAttempt("user-a")).status).toBe(401);
    expect((await sourceAttempt("user-b")).status).toBe(401);
    // One source cannot spread guesses over many challenged accounts either.
    expect((await sourceAttempt("user-c")).status).toBe(429);
  });

  it("reports an unusable encryption key as unavailable", async () => {
    const missingKey = secondFactorHandler({
      getKeys: () => {
        throw new SecretEnvelopeError("secret_encryption_invalid_key");
      }
    });
    const response = await missingKey.POST(jsonRequest("/api/auth/second-factor", { code: "123456" }, {
      cookie: await challengeCookie()
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "two_factor_unavailable" });
  });
});

function enrolmentRepository(overrides: Partial<TotpEnrolmentRepository> = {}) {
  const status: TwoFactorStatusWire = { available: true, enabled: true, recoveryCodesRemaining: 10 };

  return {
    confirm: vi.fn<TotpEnrolmentRepository["confirm"]>(async () => ({ kind: "confirmed", recoveryCodes: ["AAAAA-BBBBB"] })),
    disable: vi.fn<TotpEnrolmentRepository["disable"]>(async () => ({ kind: "disabled" })),
    getStatus: vi.fn<TotpEnrolmentRepository["getStatus"]>(async () => status),
    regenerateRecoveryCodes: vi.fn<TotpEnrolmentRepository["regenerateRecoveryCodes"]>(async () => ({
      kind: "regenerated",
      recoveryCodes: ["CCCCC-DDDDD"]
    })),
    start: vi.fn<TotpEnrolmentRepository["start"]>(async () => ({
      accountLabel: "ada@example.test",
      kind: "started",
      secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    })),
    ...overrides
  };
}

function enrolment(repository = enrolmentRepository(), extra: Partial<TwoFactorHandlerDeps> = {}) {
  const auth = createTestAuth({ user: { id: "user-1" } });
  const deps: TwoFactorHandlerDeps = {
    getKeys: () => keys,
    rateLimiter: createFixedWindowLoginRateLimiter({ clock: () => 0, maxAttempts: 3 }),
    repository,
    resolveAuth: auth.resolveAuth,
    ...extra
  };
  const cookie = `${SESSION_COOKIE_NAME}=${auth.token}`;

  return {
    action: (name: Parameters<typeof createTwoFactorActionHandler>[0], body: unknown, signedIn = true) =>
      createTwoFactorActionHandler(name, deps)(jsonRequest(`/api/me/two-factor/${name}`, body, signedIn ? { cookie } : {})),
    deps,
    repository,
    status: (signedIn = true) => createTwoFactorStatusHandler(deps)(new Request("http://localhost:3000/api/me/two-factor", {
      headers: signedIn ? { cookie } : {}
    }))
  };
}

describe("two-factor enrolment API", () => {
  it("is for signed-in users only", async () => {
    const { action, repository, status } = enrolment();

    expect((await status(false)).status).toBe(401);
    expect((await action("start", {}, false)).status).toBe(401);
    expect(repository.start).not.toHaveBeenCalled();
  });

  it("reports the status without caching", async () => {
    const response = await enrolment().status();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.json()).resolves.toEqual({ twoFactor: { available: true, enabled: true, recoveryCodesRemaining: 10 } });
  });

  it("starts setup with a provisioning URI and the key, passing a given proof through", async () => {
    const { action, repository } = enrolment();
    const response = await action("start", { code: "123456" });

    await expect(response.json()).resolves.toEqual({
      otpauthUri: "otpauth://totp/AIQSA:ada%40example.test?algorithm=SHA1&digits=6&issuer=AIQSA&period=30&secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    });
    expect(repository.start).toHaveBeenCalledWith(expect.objectContaining({
      keys,
      proof: { code: "123456", kind: "totp" },
      userId: "user-1"
    }));
  });

  it("refuses to replace an active secret, regenerate codes or turn off without a current code", async () => {
    const { action } = enrolment(enrolmentRepository({
      disable: async () => ({ kind: "code_required" }),
      regenerateRecoveryCodes: async () => ({ kind: "code_required" }),
      start: async () => ({ kind: "code_required" })
    }), { rateLimiter: createFixedWindowLoginRateLimiter({ clock: () => 0 }) });

    for (const name of ["start", "regenerate-codes", "disable"] as const) {
      const response = await action(name, {});

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "two_factor_code_required" });
    }
  });

  it("confirms with a TOTP code only and returns the recovery codes once", async () => {
    const { action, repository } = enrolment();
    const recoveryOnly = await action("confirm", { recoveryCode: "AAAAA-BBBBB" });

    expect(recoveryOnly.status).toBe(400);
    await expect(recoveryOnly.json()).resolves.toEqual({ error: "invalid_code" });
    expect(repository.confirm).not.toHaveBeenCalled();

    const confirmed = await action("confirm", { code: "123456" });

    expect(confirmed.headers.get("cache-control")).toContain("no-store");
    await expect(confirmed.json()).resolves.toEqual({
      recoveryCodes: ["AAAAA-BBBBB"],
      twoFactor: { available: true, enabled: true, recoveryCodesRemaining: 10 }
    });
  });

  it("maps refusals to stable codes", async () => {
    const { action } = enrolment(enrolmentRepository({
      confirm: async () => ({ kind: "setup_required" }),
      disable: async () => ({ kind: "invalid_code" }),
      regenerateRecoveryCodes: async () => ({ kind: "not_enabled" }),
      start: async () => ({ kind: "not_available" })
    }), { rateLimiter: createFixedWindowLoginRateLimiter({ clock: () => 0 }) });

    const expectations = [
      ["start", { code: "123456" }, 409, "two_factor_not_available"],
      ["confirm", { code: "123456" }, 409, "two_factor_setup_required"],
      ["regenerate-codes", { recoveryCode: "AAAAA-BBBBB" }, 409, "two_factor_not_enabled"],
      ["disable", { code: "000000" }, 400, "invalid_code"]
    ] as const;

    for (const [name, body, status, error] of expectations) {
      const response = await action(name, body);

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  it("limits code attempts per account and gives a completed action its attempt back", async () => {
    const { action, repository } = enrolment(enrolmentRepository({ disable: async () => ({ kind: "invalid_code" }) }));

    // Successful actions do not use up the budget.
    for (let index = 0; index < 5; index += 1) {
      expect((await action("regenerate-codes", { code: "123456" })).status).toBe(200);
    }
    expect(repository.regenerateRecoveryCodes).toHaveBeenCalledTimes(5);

    for (let index = 0; index < 3; index += 1) {
      expect((await action("disable", { code: "000000" })).status).toBe(400);
    }
    const limited = await action("disable", { code: "000000" });
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
  });

  it("reports an unusable encryption key as unavailable", async () => {
    const { action } = enrolment(enrolmentRepository(), {
      getKeys: () => {
        throw new SecretEnvelopeError("secret_encryption_invalid_key");
      }
    });
    const response = await action("start", {});

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "two_factor_unavailable" });
  });
});
