// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaAdminRepository } from "./adminRepository";
import { completeExternalSignIn, externalIdentityPolicy } from "./externalIdentity";
import { hashPassword } from "./password";
import { createPrismaPasswordAuthRepository } from "./passwordRepository";
import {
  secondFactorChallengeMatches,
  signSecondFactorChallenge,
  verifySecondFactorChallenge,
  type SecondFactorChallengeSubject
} from "./secondFactorChallenge";
import { decodeBase32, deriveRecoveryCodeKey, totpCodeAt, totpStep } from "./totp";
import type { SecondFactorAttempt } from "./totpFactor";
import {
  createPrismaSecondFactorSignInRepository,
  createPrismaTotpEnrolmentRepository
} from "./totpRepository";
import { hashToken } from "./token";

const sessionSecret = "totp-prisma-session-secret";
const encryptionKey = randomBytes(32);
const keys = { encryptionKey, recoveryCodeKey: deriveRecoveryCodeKey(encryptionKey) };
const now = new Date("2026-10-08T12:00:00.000Z");
const expiresAt = new Date("2026-10-15T12:00:00.000Z");
const enrolment = createPrismaTotpEnrolmentRepository(prisma);
const secondFactor = createPrismaSecondFactorSignInRepository(prisma);
const passwords = createPrismaPasswordAuthRepository(prisma);

function at(seconds: number): Date {
  return new Date(now.getTime() + seconds * 1000);
}

function codeFor(secret: string, when: Date): string {
  return totpCodeAt(decodeBase32(secret)!, totpStep(when));
}

type Fixture = {
  email(localPart: string): string;
  /** An active user with a verified password identity. */
  passwordUser(localPart: string): Promise<{ identityId: string; passwordHash: string; userId: string }>;
  session(label: string): { createdByUserAgent: string; expiresAt: Date; lastSeenAt: Date; tokenHash: string };
};

async function withTotpData<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `totp-${id}.example.com`;
  const email = (localPart: string) => `${localPart}@${domain}`;

  try {
    return await run({
      email,
      async passwordUser(localPart) {
        const passwordHash = await hashPassword(`totp-password-${id}`);
        const user = await prisma.user.create({
          data: { displayName: `TOTP ${localPart}`, email: email(localPart), status: "active" }
        });
        const identity = await prisma.authIdentity.create({
          data: {
            emailVerifiedAt: now,
            normalizedEmail: email(localPart),
            passwordHash,
            provider: "password",
            providerAccountId: email(localPart),
            userId: user.id
          }
        });
        return { identityId: identity.id, passwordHash, userId: user.id };
      },
      session(label) {
        return { createdByUserAgent: "TOTP Test", expiresAt, lastSeenAt: now, tokenHash: hashToken(`${label}-${id}`) };
      }
    });
  } finally {
    // Revoked-by references from the admin reset go first: they restrict deleting the admin.
    await prisma.authSession.deleteMany({ where: { user: { email: { endsWith: `@${domain}` } } } });
    await prisma.user.deleteMany({
      where: { authIdentities: { some: { normalizedEmail: { endsWith: `@${domain}` } } } }
    });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  }
}

/** Turns TOTP on for the user through the enrolment API and returns the secret and codes. */
async function enrol(userId: string, when = now): Promise<{ recoveryCodes: string[]; secret: string }> {
  const started = await enrolment.start({ keys, now: when, proof: null, userId });
  if (started.kind !== "started") throw new Error(`start_${started.kind}`);
  const confirmed = await enrolment.confirm({ code: codeFor(started.secret, when), keys, now: when, userId });
  if (confirmed.kind !== "confirmed") throw new Error(`confirm_${confirmed.kind}`);
  return { recoveryCodes: confirmed.recoveryCodes, secret: started.secret };
}

async function challengeFor(subject: SecondFactorChallengeSubject, when = now) {
  const token = await signSecondFactorChallenge(subject, { now: when, sessionSecret });
  const challenge = (await verifySecondFactorChallenge(token, { now: when, sessionSecret }))!;

  return {
    challenge,
    matchesChallenge: (current: { credential: string; factorBinding: string }) =>
      secondFactorChallengeMatches(challenge, current, sessionSecret)
  };
}

/** The first factor of a password sign-in: either a session or the challenge subject. */
async function passwordSignIn(user: { identityId: string; passwordHash: string }, session: ReturnType<Fixture["session"]>) {
  return passwords.createSessionForCurrentPassword({ identityId: user.identityId, passwordHash: user.passwordHash, session });
}

async function redeem(input: {
  attempt: SecondFactorAttempt;
  session: ReturnType<Fixture["session"]>;
  subject: SecondFactorChallengeSubject;
  when?: Date;
}) {
  const { challenge, matchesChallenge } = await challengeFor(input.subject, input.when);

  return secondFactor.completeSecondFactorSignIn({
    attempt: input.attempt,
    challenge,
    keys,
    matchesChallenge,
    now: input.when ?? now,
    session: input.session
  });
}

function sessionsOf(userId: string) {
  return prisma.authSession.findMany({ select: { revokedAt: true, signInMethod: true }, where: { userId } });
}

describe("TOTP two-factor sign-in", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("turns on only with a code from the new secret and stores hashed recovery codes", async () => {
    await withTotpData(async (fixture) => {
      const user = await fixture.passwordUser("enrol");
      const started = await enrolment.start({ keys, now, proof: null, userId: user.userId });
      if (started.kind !== "started") throw new Error("not_started");

      await expect(enrolment.getStatus(user.userId)).resolves.toEqual({ available: true, enabled: false, recoveryCodesRemaining: 0 });
      await expect(enrolment.confirm({ code: "000000", keys, now, userId: user.userId })).resolves.toEqual({ kind: "invalid_code" });
      // A pending secret alone never asks for a second factor.
      await expect(passwordSignIn(user, fixture.session("before-confirm"))).resolves.toMatchObject({ kind: "session" });

      const confirmed = await enrolment.confirm({ code: codeFor(started.secret, now), keys, now, userId: user.userId });
      if (confirmed.kind !== "confirmed") throw new Error("not_confirmed");

      expect(confirmed.recoveryCodes).toHaveLength(10);
      await expect(enrolment.getStatus(user.userId)).resolves.toEqual({ available: true, enabled: true, recoveryCodesRemaining: 10 });
      const factor = await prisma.authTotpFactor.findUniqueOrThrow({ where: { userId: user.userId } });
      expect(factor).toMatchObject({ confirmedAt: now, lastUsedStep: BigInt(totpStep(now)), pendingSecretEnvelope: null });
      expect(factor.secretEnvelope).not.toContain(started.secret);
      const stored = await prisma.authRecoveryCode.findMany({ select: { codeHash: true }, where: { userId: user.userId } });
      expect(stored.map(({ codeHash }) => codeHash).join()).not.toContain(confirmed.recoveryCodes[0]!.replace("-", ""));
      // A setup confirmed is not confirmed twice.
      await expect(enrolment.confirm({ code: codeFor(started.secret, at(30)), keys, now: at(30), userId: user.userId }))
        .resolves.toEqual({ kind: "setup_required" });
    });
  });

  it("issues no session before the second factor and one after it, in the code's transaction", async () => {
    await withTotpData(async (fixture) => {
      const user = await fixture.passwordUser("signin");
      const { secret } = await enrol(user.userId);
      const first = await passwordSignIn(user, fixture.session("first-step"));

      if (first?.kind !== "second_factor_required") throw new Error("no_challenge");
      expect(first.challenge).toMatchObject({ identityId: user.identityId, signInMethod: "password", userId: user.userId });
      await expect(sessionsOf(user.userId)).resolves.toEqual([]);

      // The code that confirmed the setup was already used.
      await expect(redeem({ attempt: { code: codeFor(secret, now), kind: "totp" }, session: fixture.session("replay"), subject: first.challenge }))
        .resolves.toEqual({ kind: "invalid_code" });
      await expect(redeem({ attempt: { code: "000000", kind: "totp" }, session: fixture.session("wrong"), subject: first.challenge }))
        .resolves.toEqual({ kind: "invalid_code" });

      const signedIn = await redeem({
        attempt: { code: codeFor(secret, at(30)), kind: "totp" },
        session: fixture.session("second-step"),
        subject: first.challenge,
        when: at(30)
      });

      expect(signedIn).toMatchObject({ kind: "session", user: { id: user.userId } });
      await expect(sessionsOf(user.userId)).resolves.toEqual([{ revokedAt: null, signInMethod: "password" }]);
      // The challenge is spent: the factor state it was bound to has changed.
      await expect(redeem({
        attempt: { code: codeFor(secret, at(60)), kind: "totp" },
        session: fixture.session("again"),
        subject: first.challenge,
        when: at(60)
      })).resolves.toEqual({ kind: "challenge_expired" });
    });
  });

  it("issues exactly one session for two parallel submits of the same code", async () => {
    await withTotpData(async (fixture) => {
      const user = await fixture.passwordUser("race");
      const { secret } = await enrol(user.userId);
      const first = await passwordSignIn(user, fixture.session("race-first"));
      if (first?.kind !== "second_factor_required") throw new Error("no_challenge");
      const second = await passwordSignIn(user, fixture.session("race-other-tab"));
      if (second?.kind !== "second_factor_required") throw new Error("no_challenge");
      const code = codeFor(secret, at(30));

      const results = await Promise.all([
        redeem({ attempt: { code, kind: "totp" }, session: fixture.session("race-a"), subject: first.challenge, when: at(30) }),
        redeem({ attempt: { code, kind: "totp" }, session: fixture.session("race-b"), subject: first.challenge, when: at(30) }),
        redeem({ attempt: { code, kind: "totp" }, session: fixture.session("race-c"), subject: second.challenge, when: at(30) })
      ]);

      expect(results.filter((result) => result.kind === "session")).toHaveLength(1);
      await expect(prisma.authSession.count({ where: { userId: user.userId } })).resolves.toBe(1);
    });
  });

  it("accepts each recovery code once", async () => {
    await withTotpData(async (fixture) => {
      const user = await fixture.passwordUser("recovery");
      const { recoveryCodes } = await enrol(user.userId);
      const recoveryCode = recoveryCodes[3]!.toLowerCase();
      const first = await passwordSignIn(user, fixture.session("recovery-first"));
      if (first?.kind !== "second_factor_required") throw new Error("no_challenge");

      await expect(redeem({ attempt: { code: recoveryCode, kind: "recovery" }, session: fixture.session("recovery-ok"), subject: first.challenge }))
        .resolves.toMatchObject({ kind: "session" });
      await expect(enrolment.getStatus(user.userId)).resolves.toMatchObject({ recoveryCodesRemaining: 9 });

      const again = await passwordSignIn(user, fixture.session("recovery-again"));
      if (again?.kind !== "second_factor_required") throw new Error("no_challenge");
      await expect(redeem({ attempt: { code: recoveryCode, kind: "recovery" }, session: fixture.session("recovery-reuse"), subject: again.challenge }))
        .resolves.toEqual({ kind: "invalid_code" });
      await expect(prisma.authSession.count({ where: { userId: user.userId } })).resolves.toBe(1);
    });
  });

  it("invalidates the challenge when the password changes between the steps, and survives a reset by email", async () => {
    await withTotpData(async (fixture) => {
      const user = await fixture.passwordUser("changed");
      const { secret } = await enrol(user.userId);
      const first = await passwordSignIn(user, fixture.session("changed-first"));
      if (first?.kind !== "second_factor_required") throw new Error("no_challenge");

      await passwords.createPasswordResetToken({
        expiresAt,
        identityId: user.identityId,
        normalizedEmail: fixture.email("changed"),
        sentToEmail: fixture.email("changed"),
        tokenHash: hashToken(`reset-${user.userId}`),
        userId: user.userId
      });
      const newHash = await hashPassword("a-new-password-after-reset");
      await expect(passwords.completePasswordReset({ now, passwordHash: newHash, tokenHash: hashToken(`reset-${user.userId}`) }))
        .resolves.not.toBeNull();

      await expect(redeem({
        attempt: { code: codeFor(secret, at(30)), kind: "totp" },
        session: fixture.session("changed-second"),
        subject: first.challenge,
        when: at(30)
      })).resolves.toEqual({ kind: "challenge_expired" });
      // Reset by email never turns two-factor off.
      await expect(enrolment.getStatus(user.userId)).resolves.toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
      await expect(passwordSignIn({ ...user, passwordHash: newHash }, fixture.session("after-reset")))
        .resolves.toMatchObject({ kind: "second_factor_required" });
    });
  });

  it("refuses to replace the secret, regenerate codes or turn off without a current code", async () => {
    await withTotpData(async (fixture) => {
      const user = await fixture.passwordUser("guarded");
      const { recoveryCodes, secret } = await enrol(user.userId);
      const before = await prisma.authTotpFactor.findUniqueOrThrow({ where: { userId: user.userId } });

      for (const proof of [null, { code: "000000", kind: "totp" as const }, { code: "ZZZZZ-ZZZZZ", kind: "recovery" as const }]) {
        const expected = proof ? "invalid_code" : "code_required";
        await expect(enrolment.start({ keys, now: at(30), proof, userId: user.userId })).resolves.toEqual({ kind: expected });
        await expect(enrolment.regenerateRecoveryCodes({ keys, now: at(30), proof, userId: user.userId }))
          .resolves.toEqual({ kind: expected });
        await expect(enrolment.disable({ keys, now: at(30), proof, userId: user.userId })).resolves.toEqual({ kind: expected });
      }
      await expect(prisma.authTotpFactor.findUniqueOrThrow({ where: { userId: user.userId } })).resolves.toMatchObject({
        pendingSecretEnvelope: null,
        secretEnvelope: before.secretEnvelope
      });

      // With a current code a new setup starts, and the active secret stays until it is confirmed.
      const restarted = await enrolment.start({ keys, now: at(30), proof: { code: codeFor(secret, at(30)), kind: "totp" }, userId: user.userId });
      expect(restarted.kind).toBe("started");
      await expect(prisma.authTotpFactor.findUniqueOrThrow({ where: { userId: user.userId } })).resolves.toMatchObject({
        secretEnvelope: before.secretEnvelope
      });

      const regenerated = await enrolment.regenerateRecoveryCodes({
        keys,
        now: at(60),
        proof: { code: recoveryCodes[0]!, kind: "recovery" },
        userId: user.userId
      });
      if (regenerated.kind !== "regenerated") throw new Error("not_regenerated");
      expect(regenerated.recoveryCodes).not.toContain(recoveryCodes[1]);
      await expect(enrolment.disable({ keys, now: at(60), proof: { code: recoveryCodes[1]!, kind: "recovery" }, userId: user.userId }))
        .resolves.toEqual({ kind: "invalid_code" });

      await expect(enrolment.disable({
        keys,
        now: at(60),
        proof: { code: regenerated.recoveryCodes[0]!, kind: "recovery" },
        userId: user.userId
      })).resolves.toEqual({ kind: "disabled" });
      await expect(prisma.authTotpFactor.count({ where: { userId: user.userId } })).resolves.toBe(0);
      await expect(prisma.authRecoveryCode.count({ where: { userId: user.userId } })).resolves.toBe(0);
    });
  });

  it("lets an administrator reset the factor and sign the user out everywhere", async () => {
    await withTotpData(async (fixture) => {
      const admin = await prisma.user.create({
        data: { displayName: "TOTP Admin", email: fixture.email("operator"), role: "admin", status: "active" }
      });
      const user = await fixture.passwordUser("reset");
      await enrol(user.userId);
      await prisma.authSession.create({ data: { expiresAt, signInMethod: "password", tokenHash: hashToken(`existing-${user.userId}`), userId: user.userId } });

      await expect(createPrismaAdminRepository(prisma).resetUserTwoFactor({ revokedByUserId: admin.id, userId: user.userId }))
        .resolves.toBe(1);
      await expect(prisma.authTotpFactor.count({ where: { userId: user.userId } })).resolves.toBe(0);
      await expect(prisma.authRecoveryCode.count({ where: { userId: user.userId } })).resolves.toBe(0);
      await expect(prisma.authSession.count({ where: { revokedAt: null, userId: user.userId } })).resolves.toBe(0);
      await expect(passwordSignIn(user, fixture.session("after-admin-reset"))).resolves.toMatchObject({ kind: "session" });
      await expect(createPrismaAdminRepository(prisma).resetUserTwoFactor({ revokedByUserId: admin.id, userId: randomUUID() }))
        .resolves.toBeNull();
    });
  });

  it("offers TOTP only to accounts with a password or LDAP identity", async () => {
    await withTotpData(async (fixture) => {
      const ssoOnly = await prisma.user.create({ data: { displayName: "SSO Only", email: fixture.email("sso"), status: "active" } });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: fixture.email("sso"),
          provider: "oidc",
          providerAccountId: `sso-${ssoOnly.id}`,
          source: "https://idp.example.test",
          userId: ssoOnly.id
        }
      });

      await expect(enrolment.getStatus(ssoOnly.id)).resolves.toEqual({ available: false, enabled: false, recoveryCodesRemaining: 0 });
      await expect(enrolment.start({ keys, now, proof: null, userId: ssoOnly.id })).resolves.toEqual({ kind: "not_available" });
      await expect(prisma.authTotpFactor.count({ where: { userId: ssoOnly.id } })).resolves.toBe(0);
    });
  });

  it("asks LDAP sign-ins of a user with TOTP for a second factor bound to the LDAP identity", async () => {
    await withTotpData(async (fixture) => {
      const directory = `ldap://directory-${randomUUID()}.example.test`;
      const subject = `uid-${randomUUID()}`;
      const ldapInput = {
        displayName: "Directory User",
        email: fixture.email("directory"),
        emailVerified: true,
        groups: [],
        now,
        policy: externalIdentityPolicy({ adminGroups: [], allowedGroups: [], autoCreateUsers: true, syncGroups: false }),
        provider: "ldap" as const,
        signInMethod: "ldap" as const,
        source: directory,
        subject
      };

      const created = await completeExternalSignIn(prisma, { ...ldapInput, session: fixture.session("ldap-first") });
      if (created.status !== "active") throw new Error("not_active");
      const { secret } = await enrol(created.userId);

      const challenged = await completeExternalSignIn(prisma, { ...ldapInput, session: fixture.session("ldap-second") });
      if (challenged.status !== "second_factor_required") throw new Error("no_challenge");
      const identity = await prisma.authIdentity.findUniqueOrThrow({
        where: { provider_providerAccountId: { provider: "ldap", providerAccountId: subject } }
      });
      expect(challenged.challenge).toMatchObject({
        credential: identity.id,
        identityId: identity.id,
        signInMethod: "ldap",
        userId: created.userId
      });
      await expect(prisma.authSession.count({ where: { tokenHash: fixture.session("ldap-second").tokenHash } })).resolves.toBe(0);

      await expect(redeem({
        attempt: { code: codeFor(secret, at(30)), kind: "totp" },
        session: fixture.session("ldap-redeemed"),
        subject: challenged.challenge,
        when: at(30)
      })).resolves.toMatchObject({ kind: "session" });
      await expect(prisma.authSession.findUniqueOrThrow({
        select: { signInMethod: true },
        where: { tokenHash: fixture.session("ldap-redeemed").tokenHash }
      })).resolves.toEqual({ signInMethod: "ldap" });
    });
  });
});
