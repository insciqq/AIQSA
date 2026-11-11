// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AUTH_SESSION_SIGN_IN_METHODS } from "@/lib/contracts/authSignInMethods";
import { createMemoryAuthMailer } from "@/tests/support/authMailers";
import { prisma } from "../prisma";
import { getAuthConfig } from "./config";
import { completeExternalSignIn, externalIdentityPolicy } from "./externalIdentity";
import { createPasswordLoginHandler, createPasswordResetRequestHandler } from "./handlers";
import { hashPassword } from "./password";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import { createFixedWindowLoginRateLimiter } from "./rateLimit";
import { createPrismaAuthRegistrationRepository } from "./registrationRepository";
import { createServiceAccount, findServiceAccount } from "./serviceAccounts";
import { issueSignInSession } from "./signInCompletion";
import { hashToken } from "./token";
import { createPrismaTotpEnrolmentRepository } from "./totpRepository";

const now = new Date("2026-11-12T00:00:00.000Z");
const config = getAuthConfig({
  AIQSA_APP_BASE_URL: "http://localhost:3000",
  AIQSA_AUTH_SESSION_SECRET: "service-account-test-secret"
});

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://app.local${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

async function withServiceAccount<T>(run: (input: { adminId: string; email: string; serviceId: string }) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const email = `service-${id}@example.com`;
  const admin = await prisma.user.create({
    data: { displayName: "Service Test Admin", email: `admin-${id}@example.com`, role: "admin", status: "active" }
  });
  let serviceId: string | null = null;

  try {
    const created = await prisma.$transaction((tx) =>
      createServiceAccount(tx, { createdByUserId: admin.id, displayName: "Connector service" }));
    if (created.kind !== "created") throw new Error(`service_account_${created.kind}`);
    serviceId = created.account.id;
    return await run({ adminId: admin.id, email, serviceId });
  } finally {
    await prisma.authFlowToken.deleteMany({ where: { normalizedEmail: email } });
    await prisma.authInvite.deleteMany({ where: { normalizedEmail: email } });
    await prisma.authAccessRule.deleteMany({ where: { value: email } });
    await prisma.signInRefusal.deleteMany({ where: { email } });
    if (serviceId) await prisma.user.deleteMany({ where: { id: serviceId } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  }
}

describe("service accounts in the database", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates an active, emailless, identity-less account with settings and Memory off", async () => {
    await withServiceAccount(async ({ serviceId }) => {
      await expect(prisma.user.findUniqueOrThrow({
        select: { email: true, kind: true, role: true, status: true },
        where: { id: serviceId }
      })).resolves.toEqual({ email: null, kind: "service", role: "user", status: "active" });
      await expect(prisma.authIdentity.count({ where: { userId: serviceId } })).resolves.toBe(0);
      await expect(prisma.userSettings.count({ where: { userId: serviceId } })).resolves.toBe(1);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        select: { learnAutomatically: true, referenceChatHistory: true, useMemoryFacts: true },
        where: { userId: serviceId }
      })).resolves.toEqual({ learnAutomatically: false, referenceChatHistory: false, useMemoryFacts: false });
      await expect(findServiceAccount(prisma, serviceId))
        .resolves.toEqual({ displayName: "Connector service", id: serviceId, status: "active" });
    });
  });

  it("keeps a service account a non-administrator without an email in the database", async () => {
    await withServiceAccount(async ({ email, serviceId }) => {
      await expect(prisma.user.update({ data: { role: "admin" }, where: { id: serviceId } })).rejects.toThrow();
      await expect(prisma.user.update({ data: { email }, where: { id: serviceId } })).rejects.toThrow();
      await expect(prisma.user.findUniqueOrThrow({ select: { email: true, role: true }, where: { id: serviceId } }))
        .resolves.toEqual({ email: null, role: "user" });
    });
  });

  it("issues no session by any method, the bootstrap token included", async () => {
    await withServiceAccount(async ({ serviceId }) => {
      for (const signInMethod of AUTH_SESSION_SIGN_IN_METHODS) {
        await expect(prisma.$transaction((tx) => issueSignInSession(tx, {
          session: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash: hashToken(randomUUID()) },
          signInMethod,
          userId: serviceId
        }))).resolves.toEqual({ kind: "refused" });
      }
      await expect(prisma.authSession.count({ where: { userId: serviceId } })).resolves.toBe(0);
    });
  });

  it("refuses registration, verification, invitations, password sign-in, reset and two-factor with a planted identity", async () => {
    await withServiceAccount(async ({ email, serviceId }) => {
      const registration = createPrismaAuthRegistrationRepository(prisma);
      const passwords = createPrismaPasswordAuthRepository(prisma);
      const identity = await prisma.authIdentity.create({
        data: {
          normalizedEmail: email,
          passwordHash: await hashPassword("planted-password"),
          provider: "password",
          providerAccountId: email,
          userId: serviceId
        }
      });
      await prisma.authAccessRule.create({ data: { kind: "email", value: email } });

      // Registration answers like a disabled account: no verification link, no email.
      await expect(registration.registerPasswordUser({
        displayName: "Someone",
        email,
        expiresAt: new Date("2026-11-13T00:00:00.000Z"),
        normalizedEmail: email,
        now,
        verificationTokenHash: hashToken(randomUUID())
      })).resolves.toEqual({ ok: true, sentToEmail: null });
      await expect(prisma.authFlowToken.count({ where: { identityId: identity.id } })).resolves.toBe(0);

      // A planted verification link proves nothing.
      const verificationToken = randomUUID();
      await prisma.authFlowToken.create({
        data: {
          expiresAt: new Date("2026-11-13T00:00:00.000Z"),
          identityId: identity.id,
          normalizedEmail: email,
          purpose: "email_verification",
          sentToEmail: email,
          tokenHash: hashToken(verificationToken),
          userId: serviceId
        }
      });
      await expect(registration.completeEmailVerification({
        now,
        passwordHash: await hashPassword("chosen-password"),
        tokenHash: hashToken(verificationToken)
      })).resolves.toBeNull();

      // An invitation for the identity's address is never accepted into the service account.
      const inviteToken = randomUUID();
      const invite = await prisma.authInvite.create({
        data: { email, expiresAt: new Date("2026-11-13T00:00:00.000Z"), normalizedEmail: email }
      });
      await prisma.authFlowToken.create({
        data: {
          expiresAt: new Date("2026-11-13T00:00:00.000Z"),
          inviteId: invite.id,
          normalizedEmail: email,
          purpose: "invite_acceptance",
          sentToEmail: email,
          tokenHash: hashToken(inviteToken)
        }
      });
      await expect(registration.acceptInvite({
        displayName: "Someone",
        inviteTokenHash: hashToken(inviteToken),
        now,
        passwordHash: await hashPassword("chosen-password"),
        session: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash: hashToken(randomUUID()) }
      })).resolves.toBeNull();

      // Even a verified password with the right hash neither signs in nor resets.
      await prisma.authIdentity.update({ data: { emailVerifiedAt: now }, where: { id: identity.id } });
      const login = createPasswordLoginHandler({
        getConfig: () => config,
        loginRateLimiter: createFixedWindowLoginRateLimiter(),
        repository: passwords
      });
      const loginResponse = await login(jsonRequest("/api/auth/login", { email, password: "planted-password" }));
      expect(loginResponse.status).toBe(401);
      expect(loginResponse.headers.get("set-cookie")).toBeNull();
      const mailer = createMemoryAuthMailer();
      const reset = createPasswordResetRequestHandler({
        getConfig: () => config,
        mailer,
        repository: passwords,
        resetRateLimiter: createFixedWindowLoginRateLimiter(),
        responseFloorMs: 0
      });
      expect((await reset(jsonRequest("/api/auth/password/reset", { email }))).status).toBe(200);
      expect(mailer.sent).toHaveLength(0);
      await expect(prisma.authFlowToken.count({ where: { purpose: "password_reset", userId: serviceId } })).resolves.toBe(0);

      await expect(createPrismaTotpEnrolmentRepository(prisma).start({
        keys: { encryptionKey: "unused" } as never,
        now,
        proof: null,
        userId: serviceId
      })).resolves.toEqual({ kind: "not_available" });
      await expect(prisma.authTotpFactor.count({ where: { userId: serviceId } })).resolves.toBe(0);
      await expect(prisma.authSession.count({ where: { userId: serviceId } })).resolves.toBe(0);
      await expect(prisma.user.findUniqueOrThrow({ select: { status: true }, where: { id: serviceId } }))
        .resolves.toEqual({ status: "active" });
    });
  });

  it("refuses an external sign-in through a planted identity", async () => {
    await withServiceAccount(async ({ email, serviceId }) => {
      const source = "https://idp.example.test/realms/service-accounts";
      const subject = `subject-${serviceId}`;
      await prisma.authIdentity.create({
        data: { emailVerifiedAt: now, normalizedEmail: email, provider: "oidc", providerAccountId: subject, source, userId: serviceId }
      });

      await expect(completeExternalSignIn(prisma, {
        displayName: "Someone",
        email,
        emailVerified: true,
        groups: [],
        now,
        policy: externalIdentityPolicy({ adminGroups: [], allowedGroups: [], autoCreateUsers: true, syncGroups: false }),
        provider: "oidc",
        session: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash: hashToken(randomUUID()) },
        signInMethod: "oidc",
        source,
        subject
      })).resolves.toEqual({ status: "not_allowed" });
      await expect(prisma.authSession.count({ where: { userId: serviceId } })).resolves.toBe(0);
    });
  });
});
