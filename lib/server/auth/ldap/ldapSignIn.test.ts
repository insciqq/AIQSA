import { describe, expect, it, vi } from "vitest";
import { ldapSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import { createFakeLdapDirectory } from "@/tests/support/fakeLdapDirectory";
import { captureSignInRecords } from "@/tests/support/signInRecords";
import { getAuthConfig } from "../config";
import type { ExternalSignInResult } from "../externalIdentity";
import { createPasswordLoginHandler } from "../handlers";
import type { PasswordAuthRepository, PasswordIdentityRecord } from "../passwordRepository";
import { createFixedWindowLoginRateLimiter, LOGIN_RATE_LIMIT_MAX_ATTEMPTS } from "../rateLimit";
import { SECOND_FACTOR_COOKIE_NAME, verifySecondFactorChallenge } from "../secondFactorChallenge";
import type { ResolvedSignInMethod } from "../signInMethods";
import { createLdapPasswordFormSignIn, LDAP_RESPONSE_FLOOR_MS, type LdapPasswordFormDeps } from "./ldapSignIn";

const authConfig = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" });
const SERVICE = { dn: "cn=aiqsa-bind,dc=example,dc=test", password: "service-secret" };
const BASE = "ou=people,dc=example,dc=test";

const ldap: ResolvedSignInMethod<"ldap"> = {
  activeVersion: 3,
  config: ldapSignInConfigSchema.parse({
    adminGroups: ["aiqsa-admins"],
    allowedGroups: ["researchers"],
    bindDn: SERVICE.dn,
    loginUsesUsername: true,
    syncGroups: true,
    url: "ldaps://ldap.example.test",
    userSearchBase: BASE,
    userSearchFilter: "(|(uid={{username}})(mail={{username}}))"
  }),
  method: "ldap",
  secrets: { bindPassword: SERVICE.password },
  source: "admin"
};

const user = { displayName: "Jane Doe", email: "jane@example.test", id: "user-jane", role: "user", status: "active" };

function fakeDirectory() {
  return createFakeLdapDirectory({
    service: SERVICE,
    users: [{
      attributes: {
        cn: ["Jane Doe"],
        entryUUID: ["uuid-jane"],
        mail: ["jane@example.test"],
        memberOf: ["cn=researchers,ou=groups,dc=example,dc=test", "cn=aiqsa-admins,ou=groups,dc=example,dc=test"],
        uid: ["jdoe"]
      },
      dn: `uid=jdoe,${BASE}`,
      password: "correct horse"
    }]
  });
}

function localIdentity(email: string): PasswordIdentityRecord {
  return {
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    id: "identity-local",
    normalizedEmail: email,
    passwordHash: "local-hash",
    user: { displayName: "Break Glass", email, id: "user-local", role: "admin", status: "active" },
    userId: "user-local"
  };
}

function setup(input: {
  active?: boolean;
  directory?: ReturnType<typeof fakeDirectory>;
  localEmail?: string;
  passwordLoginEnabled?: boolean;
  settled?: ExternalSignInResult;
} = {}) {
  const directory = input.directory ?? fakeDirectory();
  const sleeps: number[] = [];
  const recordOutcome = vi.fn<LdapPasswordFormDeps["recordOutcome"]>(async () => undefined);
  const completeSignIn = vi.fn<LdapPasswordFormDeps["completeSignIn"]>(async () =>
    input.settled ?? { sessionId: "session-1", status: "active", userId: user.id });
  const findPasswordIdentityByEmail = vi.fn(async (email: string) => (email === input.localEmail ? localIdentity(email) : null));
  const createSessionForCurrentPassword = vi.fn(async () => ({
    kind: "session" as const,
    user: localIdentity(input.localEmail ?? "").user
  }));
  const verifyPassword = vi.fn(async (password: string, hash: string | null | undefined) =>
    hash === "local-hash" && password === "local password");
  const loginRateLimiter = createFixedWindowLoginRateLimiter();
  const POST = createPasswordLoginHandler({
    directorySignIn: createLdapPasswordFormSignIn({
      clock: () => 1_000,
      completeSignIn,
      connect: () => directory.connect,
      findUser: async (userId) => (userId === user.id ? user : null),
      now: () => new Date("2026-10-08T12:00:00.000Z"),
      recordOutcome,
      resolveLdap: async () => (input.active === false ? null : ldap),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    }),
    getConfig: () => authConfig,
    loginRateLimiter,
    repository: { createSessionForCurrentPassword, findPasswordIdentityByEmail } as unknown as PasswordAuthRepository,
    signInPolicy: async () => ({ passwordLoginEnabled: input.passwordLoginEnabled ?? true, registrationEnabled: true }),
    verifyPassword
  });
  return { completeSignIn, createSessionForCurrentPassword, directory, findPasswordIdentityByEmail, POST, recordOutcome, sleeps, verifyPassword };
}

function login(email: string, password: string): Request {
  return new Request("http://localhost:3000/api/auth/login", {
    body: JSON.stringify({ email, password }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("LDAP on the password form", () => {
  it("signs in by username and by email through settlement with the LDAP source and policy", async () => {
    for (const name of ["jdoe", "jane@example.test"]) {
      const harness = setup();
      const response = await harness.POST(login(name, "correct horse"));

      expect(response.status).toBe(200);
      await expect(body(response)).resolves.toEqual({ user });
      expect(response.headers.get("set-cookie")).toMatch(/^aiqsa_session=/u);
      expect(harness.completeSignIn).toHaveBeenCalledWith(expect.objectContaining({
        email: "jane@example.test",
        emailVerified: false,
        groups: ["researchers", "aiqsa-admins"],
        policy: {
          adminGroups: ["aiqsa-admins"],
          admission: { allowedGroups: ["researchers"], kind: "groups" },
          autoCreateUsers: true,
          syncGroups: true,
          trustUnverifiedEmail: true
        },
        provider: "ldap",
        signInMethod: "ldap",
        source: "ldap://ldap.example.test/ou=people,dc=example,dc=test",
        subject: "uuid-jane"
      }));
      expect(harness.recordOutcome).toHaveBeenCalledWith(ldap, "accepted");
      expect(harness.sleeps).toEqual([]);
    }
  });

  it("answers an unknown name and a wrong password identically, after the same floor", async () => {
    const unknown = setup();
    const wrong = setup();
    const unknownResponse = await unknown.POST(login("nobody", "correct horse"));
    const wrongResponse = await wrong.POST(login("jdoe", "wrong password"));

    expect([unknownResponse.status, wrongResponse.status]).toEqual([401, 401]);
    expect(await body(unknownResponse)).toEqual(await body(wrongResponse));
    expect([...unknownResponse.headers.keys()]).toEqual([...wrongResponse.headers.keys()]);
    expect(unknown.sleeps).toEqual([LDAP_RESPONSE_FLOOR_MS]);
    expect(wrong.sleeps).toEqual([LDAP_RESPONSE_FLOOR_MS]);
    expect(unknown.completeSignIn).not.toHaveBeenCalled();
    expect(wrong.recordOutcome).not.toHaveBeenCalled();
  });

  it("refuses a whitespace password before the directory is contacted", async () => {
    const harness = setup();
    const response = await harness.POST(login("jdoe", "   "));

    expect(response.status).toBe(400);
    await expect(body(response)).resolves.toEqual({ error: "credentials_required" });
    expect(harness.directory.binds).toEqual([]);
    expect(harness.directory.searches).toEqual([]);
  });

  it("refuses an over-long or control-character name without contacting the directory", async () => {
    for (const name of ["j".repeat(257), "jdoe\u0007"]) {
      const harness = setup();
      const response = await harness.POST(login(name, "correct horse"));

      expect(response.status).toBe(401);
      expect(harness.directory.searches).toEqual([]);
    }
  });

  it("keeps a usable local password first while password sign-in is on", async () => {
    const harness = setup({ localEmail: "admin@example.test" });

    const signedIn = await harness.POST(login("admin@example.test", "local password"));
    expect(signedIn.status).toBe(200);
    expect(harness.createSessionForCurrentPassword).toHaveBeenCalledTimes(1);
    expect(harness.directory.searches).toEqual([]);

    // A wrong local password waits for the directory's floor, so the route stays hidden.
    const refused = await harness.POST(login("admin@example.test", "directory password"));
    expect(refused.status).toBe(401);
    expect(harness.sleeps).toEqual([LDAP_RESPONSE_FLOOR_MS]);
    expect(harness.directory.searches).toEqual([]);
  });

  it("uses the directory for every name while local passwords are off", async () => {
    const harness = setup({ localEmail: "jane@example.test", passwordLoginEnabled: false });
    const response = await harness.POST(login("jane@example.test", "correct horse"));

    expect(response.status).toBe(200);
    expect(harness.verifyPassword).not.toHaveBeenCalled();
    expect(harness.completeSignIn).toHaveBeenCalledTimes(1);
  });

  it("leaves the form to local passwords while LDAP is not active", async () => {
    const harness = setup({ active: false, passwordLoginEnabled: false });
    const response = await harness.POST(login("jdoe", "correct horse"));

    expect(response.status).toBe(403);
    await expect(body(response)).resolves.toEqual({ error: "password_login_disabled" });
    expect(harness.directory.searches).toEqual([]);
  });

  it("answers ldap_unavailable for an unreachable directory and records a content-free health code", async () => {
    const harness = setup({ directory: createFakeLdapDirectory({ fail: { connect: "tls_failed" }, service: SERVICE, users: [] }) });
    const response = await harness.POST(login("jdoe", "correct horse"));

    expect(response.status).toBe(503);
    await expect(body(response)).resolves.toEqual({ error: "ldap_unavailable" });
    expect(harness.recordOutcome).toHaveBeenCalledWith(ldap, "tls_failed");
    expect(harness.sleeps).toEqual([LDAP_RESPONSE_FLOOR_MS]);
  });

  it("hands a user with TOTP the second-factor challenge instead of a session", async () => {
    const harness = setup({
      settled: {
        challenge: {
          credential: "identity-ldap",
          factorBinding: "factor-1",
          identityId: "identity-ldap",
          signInMethod: "ldap",
          userId: user.id
        },
        status: "second_factor_required",
        userId: user.id
      }
    });
    const response = await harness.POST(login("jdoe", "correct horse"));

    expect(response.status).toBe(200);
    await expect(body(response)).resolves.toEqual({ status: "second_factor_required" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${SECOND_FACTOR_COOKIE_NAME}=`, "u"));
    expect(cookie).not.toMatch(/aiqsa_session=/u);
    const token = cookie.split(";")[0]!.split("=")[1]!;
    await expect(verifySecondFactorChallenge(token, { now: new Date("2026-10-08T12:01:00.000Z"), sessionSecret: authConfig.sessionSecret }))
      .resolves.toMatchObject({ identityId: "identity-ldap", signInMethod: "ldap", userId: user.id });
  });

  it("names settlement refusals for the person who proved their directory password", async () => {
    const cases = [
      ["not_allowed", 403, "not_allowed"],
      ["pending", 403, "account_pending"],
      ["account_conflict", 409, "account_conflict"],
      ["email_missing", 403, "email_missing"],
      ["source_changed", 403, "source_changed"]
    ] as const;
    for (const [status, httpStatus, error] of cases) {
      const harness = setup({ settled: { status } });
      const response = await harness.POST(login("jdoe", "correct horse"));

      expect(response.status).toBe(httpStatus);
      await expect(body(response)).resolves.toEqual({ error });
      expect(harness.recordOutcome).toHaveBeenCalledWith(ldap, status === "pending" ? "accepted" : status);
    }
  });

  it("limits attempts per directory account like password login", async () => {
    const harness = setup();
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      expect((await harness.POST(login("JDoe", "wrong password"))).status).toBe(401);
    }

    const limited = await harness.POST(login("jdoe", "correct horse"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(harness.completeSignIn).not.toHaveBeenCalled();
  });

  it("records each directory attempt once as an LDAP sign-in, a local password as a password one", async () => {
    const harness = setup({ localEmail: "admin@example.test" });
    const unreachable = setup({ directory: createFakeLdapDirectory({ fail: { connect: "tls_failed" }, service: SERVICE, users: [] }) });

    const records = await captureSignInRecords(async () => {
      expect((await harness.POST(login("jdoe", "correct horse"))).status).toBe(200);
      expect((await harness.POST(login("jdoe", "wrong password"))).status).toBe(401);
      expect((await harness.POST(login("admin@example.test", "local password"))).status).toBe(200);
      expect((await unreachable.POST(login("jdoe", "correct horse"))).status).toBe(503);
    });

    expect(records.map(({ code, level, outcome, sign_in_method, step }) => ({ code, level, outcome, sign_in_method, step }))).toEqual([
      { code: "accepted", level: "info", outcome: "succeeded", sign_in_method: "ldap", step: "credentials" },
      { code: "invalid_credentials", level: "warn", outcome: "failed", sign_in_method: "ldap", step: "credentials" },
      { code: "accepted", level: "info", outcome: "succeeded", sign_in_method: "password", step: "credentials" },
      { code: "tls_failed", level: "error", outcome: "failed", sign_in_method: "ldap", step: "credentials" }
    ]);
    // The wrong password's record covers the response floor it waited for.
    expect(records[1]).toHaveProperty("duration_ms");
    expect(JSON.stringify(records)).not.toMatch(/jdoe|jane|example\.test|horse|researchers|uuid-/u);
  });
});
