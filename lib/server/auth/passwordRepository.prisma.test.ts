import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { getAuthConfig } from "./config";
import { createPasswordLoginHandler } from "./handlers";
import { hashPassword, verifyPassword } from "./password";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import { hashToken } from "./token";

const resetNow = new Date("2026-07-14T00:00:00.000Z");
const resetExpiry = new Date("2026-07-14T01:00:00.000Z");

type ResetFixture = {
  email: string;
  identityId: string;
  oldPassword: string;
  rawTokens: string[];
  userId: string;
};

async function createResetFixture(input: {
  emailVerified?: boolean;
  status?: "active" | "denied" | "disabled" | "pending";
  tokenCount?: number;
} = {}): Promise<ResetFixture> {
  const id = randomUUID();
  const email = `password-reset-${id}@example.com`;
  const oldPassword = `old-password-${id}`;
  const user = await prisma.user.create({
    data: {
      displayName: "Password Reset Test",
      email,
      status: input.status ?? "active"
    }
  });
  const identity = await prisma.authIdentity.create({
    data: {
      emailVerifiedAt: input.emailVerified === false ? null : resetNow,
      normalizedEmail: email,
      passwordHash: await hashPassword(oldPassword),
      provider: "password",
      providerAccountId: email,
      userId: user.id
    }
  });
  const rawTokens = Array.from({ length: input.tokenCount ?? 2 }, (_value, index) => `reset-${id}-${index}`);

  await prisma.authFlowToken.createMany({
    data: rawTokens.map((token) => ({
      expiresAt: resetExpiry,
      identityId: identity.id,
      normalizedEmail: email,
      purpose: "password_reset" as const,
      sentToEmail: email,
      tokenHash: hashToken(token),
      userId: user.id
    }))
  });
  await prisma.authSession.createMany({
    data: [0, 1].map((index) => ({
      expiresAt: new Date("2026-07-21T00:00:00.000Z"),
      tokenHash: hashToken(`session-${id}-${index}`),
      userId: user.id
    }))
  });

  return {
    email,
    identityId: identity.id,
    oldPassword,
    rawTokens,
    userId: user.id
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}

async function deleteFixtures(...fixtures: ResetFixture[]): Promise<void> {
  await prisma.user.deleteMany({
    where: {
      id: {
        in: fixtures.map((fixture) => fixture.userId)
      }
    }
  });
}

describe("Prisma-backed password reset completion", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("changes one password, consumes sibling tokens, revokes all sessions, and leaves another user untouched", async () => {
    const target = await createResetFixture();
    const other = await createResetFixture({ tokenCount: 1 });
    const repository = createPrismaPasswordAuthRepository(prisma);
    const newPassword = "verified-reset-password";

    try {
      await expect(
        repository.completePasswordReset({
          now: resetNow,
          passwordHash: await hashPassword(newPassword),
          tokenHash: hashToken(target.rawTokens[0]!)
        })
      ).resolves.toEqual({ userId: target.userId });

      const [identity, targetTokens, targetSessions, otherIdentity, otherTokens, otherSessions] = await Promise.all([
        prisma.authIdentity.findUniqueOrThrow({ where: { id: target.identityId } }),
        prisma.authFlowToken.findMany({ where: { identityId: target.identityId } }),
        prisma.authSession.findMany({ where: { userId: target.userId } }),
        prisma.authIdentity.findUniqueOrThrow({ where: { id: other.identityId } }),
        prisma.authFlowToken.findMany({ where: { identityId: other.identityId } }),
        prisma.authSession.findMany({ where: { userId: other.userId } })
      ]);

      await expect(verifyPassword(newPassword, identity.passwordHash)).resolves.toBe(true);
      await expect(verifyPassword(target.oldPassword, identity.passwordHash)).resolves.toBe(false);
      expect(targetTokens.every((token) => token.consumedAt?.getTime() === resetNow.getTime())).toBe(true);
      expect(
        targetSessions.every(
          (session) =>
            session.revokedAt?.getTime() === resetNow.getTime() && session.revokedReason === "password_reset"
        )
      ).toBe(true);
      await expect(verifyPassword(other.oldPassword, otherIdentity.passwordHash)).resolves.toBe(true);
      expect(otherTokens.every((token) => token.consumedAt === null)).toBe(true);
      expect(otherSessions.every((session) => session.revokedAt === null)).toBe(true);

      await expect(
        repository.completePasswordReset({
          now: resetNow,
          passwordHash: await hashPassword("replay-password"),
          tokenHash: hashToken(target.rawTokens[1]!)
        })
      ).resolves.toBeNull();
    } finally {
      await deleteFixtures(target, other);
    }
  });

  it("rejects an old-password login whose verification finishes after reset commits", async () => {
    const fixture = await createResetFixture({ tokenCount: 1 });
    const repository = createPrismaPasswordAuthRepository(prisma);
    const verificationStarted = deferred();
    const releaseVerification = deferred();
    const POST = createPasswordLoginHandler({
      getConfig: () =>
        getAuthConfig({
          AIQSA_APP_BASE_URL: "http://localhost:3000",
          AIQSA_AUTH_SESSION_SECRET: "password-race-test-secret"
        }),
      repository,
      verifyPassword: async () => {
        verificationStarted.resolve();
        await releaseVerification.promise;
        return true;
      }
    });

    try {
      const loginPromise = POST(
        new Request("http://app.local/api/auth/login", {
          body: JSON.stringify({
            email: fixture.email,
            password: fixture.oldPassword
          }),
          headers: {
            "content-type": "application/json",
            "user-agent": "password-race-test"
          },
          method: "POST"
        })
      );

      await verificationStarted.promise;
      await expect(
        repository.completePasswordReset({
          now: resetNow,
          passwordHash: await hashPassword("replacement-password"),
          tokenHash: hashToken(fixture.rawTokens[0]!)
        })
      ).resolves.toEqual({ userId: fixture.userId });
      releaseVerification.resolve();

      const response = await loginPromise;
      const sessions = await prisma.authSession.findMany({
        where: {
          userId: fixture.userId
        }
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(sessions.every((session) => session.revokedAt?.getTime() === resetNow.getTime())).toBe(true);
    } finally {
      releaseVerification.resolve();
      await deleteFixtures(fixture);
    }
  });

  it("allows exactly one concurrent sibling token to win", async () => {
    const fixture = await createResetFixture();
    const repository = createPrismaPasswordAuthRepository(prisma);
    const passwords = ["concurrent-reset-a", "concurrent-reset-b"];

    try {
      const passwordHashes = await Promise.all(passwords.map((password) => hashPassword(password)));
      const results = await Promise.all(
        fixture.rawTokens.map((token, index) =>
          repository.completePasswordReset({
            now: resetNow,
            passwordHash: passwordHashes[index]!,
            tokenHash: hashToken(token)
          })
        )
      );
      const winner = results.findIndex((result) => result !== null);
      const identity = await prisma.authIdentity.findUniqueOrThrow({ where: { id: fixture.identityId } });
      const tokens = await prisma.authFlowToken.findMany({ where: { identityId: fixture.identityId } });

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(winner).toBeGreaterThanOrEqual(0);
      await expect(verifyPassword(passwords[winner]!, identity.passwordHash)).resolves.toBe(true);
      await expect(verifyPassword(passwords[winner === 0 ? 1 : 0]!, identity.passwordHash)).resolves.toBe(false);
      expect(tokens.every((token) => token.consumedAt instanceof Date)).toBe(true);
    } finally {
      await deleteFixtures(fixture);
    }
  });

  it("rolls back password and tokens when session revocation fails", async () => {
    const fixture = await createResetFixture();
    const failingClient = prisma.$extends({
      query: {
        authSession: {
          updateMany({ args }) {
            if (args.where?.userId === fixture.userId) {
              throw new Error("injected_session_revoke_failure");
            }

            throw new Error("unexpected_session_update");
          }
        }
      }
    });
    const repository = createPrismaPasswordAuthRepository(failingClient as unknown as PrismaClient);

    try {
      await expect(
        repository.completePasswordReset({
          now: resetNow,
          passwordHash: await hashPassword("must-roll-back"),
          tokenHash: hashToken(fixture.rawTokens[0]!)
        })
      ).rejects.toThrow("injected_session_revoke_failure");

      const [identity, tokens, sessions] = await Promise.all([
        prisma.authIdentity.findUniqueOrThrow({ where: { id: fixture.identityId } }),
        prisma.authFlowToken.findMany({ where: { identityId: fixture.identityId } }),
        prisma.authSession.findMany({ where: { userId: fixture.userId } })
      ]);

      await expect(verifyPassword(fixture.oldPassword, identity.passwordHash)).resolves.toBe(true);
      expect(tokens.every((token) => token.consumedAt === null)).toBe(true);
      expect(sessions.every((session) => session.revokedAt === null)).toBe(true);
    } finally {
      await deleteFixtures(fixture);
    }
  });

  it("rejects unverified, inactive, expired, consumed, wrong-purpose, and cross-user tokens without mutation", async () => {
    const unverified = await createResetFixture({ emailVerified: false, tokenCount: 1 });
    const disabled = await createResetFixture({ status: "disabled", tokenCount: 1 });
    const expired = await createResetFixture({ tokenCount: 1 });
    const consumed = await createResetFixture({ tokenCount: 1 });
    const wrongPurpose = await createResetFixture({ tokenCount: 1 });
    const crossUser = await createResetFixture({ tokenCount: 1 });
    const other = await createResetFixture({ tokenCount: 0 });
    const repository = createPrismaPasswordAuthRepository(prisma);

    try {
      await Promise.all([
        prisma.authFlowToken.update({
          data: { expiresAt: new Date("2026-07-13T23:59:59.000Z") },
          where: { tokenHash: hashToken(expired.rawTokens[0]!) }
        }),
        prisma.authFlowToken.update({
          data: { consumedAt: new Date("2026-07-13T23:00:00.000Z") },
          where: { tokenHash: hashToken(consumed.rawTokens[0]!) }
        }),
        prisma.authFlowToken.update({
          data: { purpose: "email_verification" },
          where: { tokenHash: hashToken(wrongPurpose.rawTokens[0]!) }
        }),
        prisma.authFlowToken.update({
          data: { userId: other.userId },
          where: { tokenHash: hashToken(crossUser.rawTokens[0]!) }
        })
      ]);

      const fixtures = [unverified, disabled, expired, consumed, wrongPurpose, crossUser];
      for (const fixture of fixtures) {
        await expect(
          repository.completePasswordReset({
            now: resetNow,
            passwordHash: await hashPassword("rejected-password"),
            tokenHash: hashToken(fixture.rawTokens[0]!)
          })
        ).resolves.toBeNull();
      }

      for (const fixture of fixtures) {
        const [identity, sessions] = await Promise.all([
          prisma.authIdentity.findUniqueOrThrow({ where: { id: fixture.identityId } }),
          prisma.authSession.findMany({ where: { userId: fixture.userId } })
        ]);
        await expect(verifyPassword(fixture.oldPassword, identity.passwordHash)).resolves.toBe(true);
        expect(sessions.every((session) => session.revokedAt === null)).toBe(true);
      }
    } finally {
      await deleteFixtures(unverified, disabled, expired, consumed, wrongPurpose, crossUser, other);
    }
  });
});
