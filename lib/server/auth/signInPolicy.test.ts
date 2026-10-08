import { describe, expect, it, vi } from "vitest";
import { createMemoryAuthMailer } from "@/tests/support/authMailers";
import { getAuthConfig } from "./config";
import {
  createPasswordLoginHandler,
  createPasswordResetCompleteHandler,
  createPasswordResetRequestHandler
} from "./handlers";
import type { PasswordAuthRepository } from "./passwordRepository";
import {
  createEmailVerificationHandler,
  createInviteAcceptanceHandler,
  createRegisterHandler
} from "./registrationHandlers";
import type { AuthRegistrationRepository } from "./registrationRepository";
import type { SignInPolicyReader } from "./signInPolicy";

const config = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "test-secret" });

/** A repository that fails the test if a refused request reaches any account lookup. */
function untouchable<T extends object>(): T {
  return new Proxy({}, {
    get: () => () => {
      throw new Error("refused request reached the repository");
    }
  }) as T;
}

function policy(passwordLoginEnabled: boolean, registrationEnabled = true): SignInPolicyReader {
  return vi.fn(async () => ({ passwordLoginEnabled, registrationEnabled }));
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

async function expectRefused(response: Response, error: string): Promise<void> {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({ error });
}

describe("sign-in switches in the auth handlers", () => {
  it("refuses every local-password operation while password sign-in is off, before any account work", async () => {
    const off = policy(false);
    const passwords = untouchable<PasswordAuthRepository>();
    const registrations = untouchable<AuthRegistrationRepository>();
    const mailer = createMemoryAuthMailer();

    await expectRefused(
      await createPasswordLoginHandler({ getConfig: () => config, repository: passwords, signInPolicy: off })(
        jsonRequest("/api/auth/login", { email: "person@example.com", password: "correct horse" })
      ),
      "password_login_disabled"
    );
    await expectRefused(
      await createPasswordResetRequestHandler({ getConfig: () => config, mailer, repository: passwords, signInPolicy: off })(
        jsonRequest("/api/auth/password-reset/request", { email: "person@example.com" })
      ),
      "password_login_disabled"
    );
    await expectRefused(
      await createPasswordResetCompleteHandler({ getConfig: () => config, repository: passwords, signInPolicy: off })(
        jsonRequest("/api/auth/password-reset/complete", { password: "a new password", token: "reset-token" })
      ),
      "password_login_disabled"
    );
    await expectRefused(
      await createRegisterHandler({ getConfig: () => config, mailer, repository: registrations, signInPolicy: off })(
        jsonRequest("/api/auth/register", { email: "person@example.com" })
      ),
      "password_login_disabled"
    );
    await expectRefused(
      await createInviteAcceptanceHandler({ getConfig: () => config, repository: registrations, signInPolicy: off })(
        jsonRequest("/api/auth/invite/accept", { password: "a new password", token: "invite-token" })
      ),
      "password_login_disabled"
    );
    await expectRefused(
      await createEmailVerificationHandler({ getConfig: () => config, repository: registrations, signInPolicy: off })(
        jsonRequest("/api/auth/verify-email", { password: "a new password", token: "verify-token" })
      ),
      "password_login_disabled"
    );
    expect(mailer.sent).toEqual([]);
  });

  it("refuses self-service registration while it is off but lets an invited registration through", async () => {
    const registrationOff = policy(true, false);
    const registerResult = vi.fn(async () => ({ ok: true as const, sentToEmail: null }));
    const repository = { registerPasswordUser: registerResult } as unknown as AuthRegistrationRepository;
    const POST = createRegisterHandler({
      getConfig: () => config,
      mailer: createMemoryAuthMailer(),
      repository,
      responseFloorMs: 0,
      signInPolicy: registrationOff
    });

    await expectRefused(await POST(jsonRequest("/api/auth/register", { email: "person@example.com" })), "registration_disabled");
    expect(registerResult).not.toHaveBeenCalled();

    const invited = await POST(jsonRequest("/api/auth/register", { email: "person@example.com", inviteToken: "invite-token" }));
    expect(invited.status).toBe(200);
    expect(registerResult).toHaveBeenCalledTimes(1);
  });

  it("keeps password sign-in on when the handler has no policy reader", async () => {
    const findPasswordIdentityByEmail = vi.fn(async () => null);
    const POST = createPasswordLoginHandler({
      getConfig: () => config,
      repository: { findPasswordIdentityByEmail } as unknown as PasswordAuthRepository
    });

    const response = await POST(jsonRequest("/api/auth/login", { email: "person@example.com", password: "wrong password" }));

    expect(response.status).toBe(401);
    expect(findPasswordIdentityByEmail).toHaveBeenCalledTimes(1);
  });
});
