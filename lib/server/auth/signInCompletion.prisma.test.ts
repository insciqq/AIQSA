// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { getAuthConfig } from "./config";
import { createTokenLoginHandler } from "./handlers";
import { hashPassword } from "./password";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import { createPrismaAuthSessionStore } from "./prismaSessions";
import { createPrismaAuthRegistrationRepository } from "./registrationRepository";
import { createAuthSession } from "./requestAuth";
import { hashToken } from "./token";

const now = new Date("2026-10-08T12:00:00.000Z");
const expiresAt = new Date("2026-10-15T12:00:00.000Z");

describe("sign-in completion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records the sign-in method of every session a sign-in creates", async () => {
    const id = randomUUID();
    const domain = `completion-${id}.example.com`;
    const email = (localPart: string) => `${localPart}@${domain}`;
    const sessionInput = (token: string) => ({
      createdByUserAgent: "Completion Test",
      expiresAt,
      lastSeenAt: now,
      tokenHash: hashToken(`${token}-${id}`)
    });

    try {
      const passwordHash = await hashPassword(`completion-password-${id}`);
      const passwordUser = await prisma.user.create({
        data: { displayName: "Completion Password User", email: email("password"), status: "active" }
      });
      const passwordIdentity = await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: email("password"),
          passwordHash,
          provider: "password",
          providerAccountId: email("password"),
          userId: passwordUser.id
        }
      });
      await expect(createPrismaPasswordAuthRepository(prisma).createSessionForCurrentPassword({
        identityId: passwordIdentity.id,
        passwordHash,
        session: sessionInput("password")
      })).resolves.toMatchObject({ user: { id: passwordUser.id } });

      const invite = await prisma.authInvite.create({
        data: { email: email("invited"), expiresAt, normalizedEmail: email("invited") }
      });
      await prisma.authFlowToken.create({
        data: {
          expiresAt,
          inviteId: invite.id,
          normalizedEmail: email("invited"),
          purpose: "invite_acceptance",
          sentToEmail: email("invited"),
          tokenHash: hashToken(`invite-${id}`)
        }
      });
      const accepted = await createPrismaAuthRegistrationRepository(prisma).acceptInvite({
        displayName: "Completion Invited User",
        inviteTokenHash: hashToken(`invite-${id}`),
        now,
        passwordHash,
        session: sessionInput("invite")
      });
      expect(accepted).not.toBeNull();

      const bootstrapUser = await prisma.user.create({
        data: { displayName: "Completion Bootstrap User", email: email("bootstrap"), role: "admin", status: "active" }
      });
      const sessions = createPrismaAuthSessionStore(prisma);
      const bootstrap = await createTokenLoginHandler({
        findUserById: async () => bootstrapUser,
        getConfig: () => getAuthConfig({
          AIQSA_AUTH_SESSION_SECRET: `completion-secret-${id}`,
          AIQSA_BOOTSTRAP_AUTH_TOKEN: `completion-bootstrap-${id}`,
          AIQSA_BOOTSTRAP_LOGIN_ENABLED: "1",
          AIQSA_BOOTSTRAP_USER_ID: bootstrapUser.id
        }),
        sessions
      })(new Request("http://app.local/api/auth/token", {
        body: JSON.stringify({ token: `completion-bootstrap-${id}` }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      expect(bootstrap.status).toBe(200);

      const oauthUser = await prisma.user.create({
        data: { displayName: "Completion OAuth User", email: email("oauth"), status: "active" }
      });
      await createAuthSession({ now, secureCookie: false, sessions, signInMethod: "yandex", userId: oauthUser.id });
      // Fixtures and tooling may still create a session without a sign-in method.
      await createAuthSession({ now, secureCookie: false, sessions, userId: oauthUser.id });

      const recorded = await prisma.authSession.findMany({
        select: { signInMethod: true, userId: true },
        where: { user: { email: { endsWith: `@${domain}` } } }
      });
      expect(recorded.map((session) => [session.userId, session.signInMethod]).sort()).toEqual([
        [accepted!.userId, "invite"],
        [bootstrapUser.id, "bootstrap"],
        [oauthUser.id, "yandex"],
        [oauthUser.id, null],
        [passwordUser.id, "password"]
      ].sort());
    } finally {
      await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
      await prisma.authFlowToken.deleteMany({ where: { normalizedEmail: email("invited") } });
      await prisma.authInvite.deleteMany({ where: { normalizedEmail: email("invited") } });
    }
  });
});
