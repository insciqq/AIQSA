import type { Prisma, PrismaClient } from "@prisma/client";
import type { TwoFactorStatusWire } from "@/lib/contracts/twoFactor";
import type { SafeUser } from "./handlers";
import type { SecondFactorSignInMethod } from "./secondFactorChallenge";
import { issueSignInSession, type SignInSessionInput } from "./signInCompletion";
import { encryptTotpSecret, generateTotpSecret, matchTotpStep, normalizeTotpCode, decryptTotpSecret } from "./totp";
import {
  lockOrCreateTotpFactor,
  lockTotpFactor,
  replaceRecoveryCodes,
  totpFactorBinding,
  verifySecondFactorAttempt,
  type SecondFactorAttempt,
  type TotpKeys
} from "./totpFactor";
import { lockAuthIdentity, lockAuthUser } from "./transactionLocks";

/** A started enrolment that nobody confirmed is discarded after this long. */
export const TOTP_SETUP_MAX_AGE_MS = 30 * 60 * 1000;

export type TotpStartResult =
  | { accountLabel: string; kind: "started"; secret: string }
  | { kind: "code_required" | "invalid_code" | "not_available" };

export type TotpConfirmResult =
  | { kind: "confirmed"; recoveryCodes: string[] }
  | { kind: "invalid_code" | "not_available" | "setup_required" };

export type TotpRegenerateResult =
  | { kind: "regenerated"; recoveryCodes: string[] }
  | { kind: "code_required" | "invalid_code" | "not_enabled" };

export type TotpDisableResult = { kind: "code_required" | "disabled" | "invalid_code" | "not_enabled" };

export type TotpEnrolmentRepository = {
  confirm(input: { code: unknown; keys: TotpKeys; now: Date; userId: string }): Promise<TotpConfirmResult>;
  disable(input: { keys: TotpKeys; now: Date; proof: SecondFactorAttempt | null; userId: string }): Promise<TotpDisableResult>;
  /** Null when the user is not an active account. */
  getStatus(userId: string): Promise<TwoFactorStatusWire | null>;
  regenerateRecoveryCodes(input: {
    keys: TotpKeys;
    now: Date;
    proof: SecondFactorAttempt | null;
    userId: string;
  }): Promise<TotpRegenerateResult>;
  start(input: { keys: TotpKeys; now: Date; proof: SecondFactorAttempt | null; userId: string }): Promise<TotpStartResult>;
};

export type SecondFactorSignInResult =
  | { kind: "challenge_expired" }
  | { kind: "invalid_code" }
  | { kind: "session"; user: SafeUser };

export type SecondFactorSignInRepository = {
  /**
   * One transaction: the challenge's identity and the user are still current, the factor
   * state still matches the challenge, the code passes the replay guard (or a recovery code
   * is spent), and the session is issued through the completion seam.
   */
  completeSecondFactorSignIn(input: {
    attempt: SecondFactorAttempt;
    challenge: { identityId: string; signInMethod: SecondFactorSignInMethod; userId: string };
    keys: TotpKeys;
    matchesChallenge(current: { credential: string; factorBinding: string }): boolean;
    now: Date;
    session: SignInSessionInput;
  }): Promise<SecondFactorSignInResult>;
};

/**
 * Accounts whose sign-in AIQSA verifies itself may use TOTP: a usable password (email proven
 * and a hash set) or an LDAP identity. Accounts that only use an IdP rely on its MFA.
 */
const totpEligibleIdentityWhere = {
  OR: [
    { emailVerifiedAt: { not: null }, passwordHash: { not: null }, provider: "password" },
    { provider: "ldap" }
  ]
} satisfies Prisma.AuthIdentityWhereInput;

async function activeEligibleUser(tx: Prisma.TransactionClient, userId: string) {
  await lockAuthUser(tx, userId);
  const user = await tx.user.findUnique({
    select: {
      authIdentities: { select: { id: true }, take: 1, where: totpEligibleIdentityWhere },
      displayName: true,
      email: true,
      status: true
    },
    where: { id: userId }
  });

  return user?.status === "active" ? { ...user, eligible: user.authIdentities.length > 0 } : null;
}

function enabled(factor: { confirmedAt: Date | null; secretEnvelope: string | null } | null): boolean {
  return Boolean(factor?.confirmedAt && factor.secretEnvelope);
}

/** Whether a proof of the confirmed factor was given and holds; spends it when it does. */
async function provenByCurrentFactor(
  tx: Prisma.TransactionClient,
  input: {
    factor: NonNullable<Awaited<ReturnType<typeof lockTotpFactor>>>;
    keys: TotpKeys;
    now: Date;
    proof: SecondFactorAttempt | null;
  }
): Promise<"code_required" | "invalid_code" | "proven"> {
  if (!input.proof) {
    return "code_required";
  }

  const proof = await verifySecondFactorAttempt(tx, {
    attempt: input.proof,
    factor: input.factor,
    keys: input.keys,
    now: input.now
  });

  return proof ? "proven" : "invalid_code";
}

export function createPrismaTotpEnrolmentRepository(prisma: PrismaClient): TotpEnrolmentRepository {
  return {
    async getStatus(userId) {
      const user = await prisma.user.findUnique({
        select: {
          authIdentities: { select: { id: true }, take: 1, where: totpEligibleIdentityWhere },
          authTotpFactor: {
            select: {
              _count: { select: { recoveryCodes: { where: { usedAt: null } } } },
              confirmedAt: true,
              secretEnvelope: true
            }
          },
          status: true
        },
        where: { id: userId }
      });

      if (user?.status !== "active") {
        return null;
      }

      const factorEnabled = enabled(user.authTotpFactor);

      return {
        available: user.authIdentities.length > 0 || factorEnabled,
        enabled: factorEnabled,
        recoveryCodesRemaining: factorEnabled ? user.authTotpFactor?._count.recoveryCodes ?? 0 : 0
      };
    },
    async start(input) {
      return prisma.$transaction(async (tx): Promise<TotpStartResult> => {
        const user = await activeEligibleUser(tx, input.userId);

        if (!user?.eligible) {
          return { kind: "not_available" };
        }

        const factor = await lockOrCreateTotpFactor(tx, input.userId, input.now);

        // A new secret never replaces a confirmed one without a current code (the LibreChat
        // CVE-2026-54036 lesson); until it is confirmed it only replaces an earlier pending one.
        if (enabled(factor)) {
          const proven = await provenByCurrentFactor(tx, { factor, keys: input.keys, now: input.now, proof: input.proof });

          if (proven !== "proven") {
            return { kind: proven };
          }
        }

        const secret = generateTotpSecret();

        await tx.authTotpFactor.update({
          data: {
            pendingCreatedAt: input.now,
            pendingSecretEnvelope: encryptTotpSecret({ key: input.keys.encryptionKey, secret, userId: input.userId })
          },
          where: { userId: input.userId }
        });

        return { accountLabel: user.email ?? user.displayName, kind: "started", secret };
      });
    },
    async confirm(input) {
      return prisma.$transaction(async (tx): Promise<TotpConfirmResult> => {
        const user = await activeEligibleUser(tx, input.userId);

        if (!user?.eligible) {
          return { kind: "not_available" };
        }

        const factor = await lockTotpFactor(tx, input.userId);

        if (
          !factor?.pendingSecretEnvelope ||
          !factor.pendingCreatedAt ||
          input.now.getTime() - factor.pendingCreatedAt.getTime() > TOTP_SETUP_MAX_AGE_MS
        ) {
          return { kind: "setup_required" };
        }

        const code = normalizeTotpCode(input.code);
        const step = code
          ? matchTotpStep({
              code,
              lastUsedStep: null,
              now: input.now,
              secret: decryptTotpSecret({ envelope: factor.pendingSecretEnvelope, key: input.keys.encryptionKey, userId: input.userId })
            })
          : null;

        if (step === null) {
          return { kind: "invalid_code" };
        }

        // The confirming code counts as used, so it cannot also complete a sign-in.
        await tx.authTotpFactor.update({
          data: {
            confirmedAt: input.now,
            lastUsedStep: BigInt(step),
            pendingCreatedAt: null,
            pendingSecretEnvelope: null,
            secretEnvelope: factor.pendingSecretEnvelope
          },
          where: { userId: input.userId }
        });

        return {
          kind: "confirmed",
          recoveryCodes: await replaceRecoveryCodes(tx, { keys: input.keys, userId: input.userId })
        };
      });
    },
    async regenerateRecoveryCodes(input) {
      return prisma.$transaction(async (tx): Promise<TotpRegenerateResult> => {
        await lockAuthUser(tx, input.userId);
        const factor = await lockTotpFactor(tx, input.userId);

        if (!factor || !enabled(factor)) {
          return { kind: "not_enabled" };
        }

        // New codes need a current code (the LibreChat CVE-2026-54040 lesson).
        const proven = await provenByCurrentFactor(tx, { factor, keys: input.keys, now: input.now, proof: input.proof });

        if (proven !== "proven") {
          return { kind: proven };
        }

        return {
          kind: "regenerated",
          recoveryCodes: await replaceRecoveryCodes(tx, { keys: input.keys, userId: input.userId })
        };
      });
    },
    async disable(input) {
      return prisma.$transaction(async (tx): Promise<TotpDisableResult> => {
        await lockAuthUser(tx, input.userId);
        const factor = await lockTotpFactor(tx, input.userId);

        if (!factor) {
          return { kind: "not_enabled" };
        }

        if (enabled(factor)) {
          const proven = await provenByCurrentFactor(tx, { factor, keys: input.keys, now: input.now, proof: input.proof });

          if (proven !== "proven") {
            return { kind: proven };
          }
        }

        // An unconfirmed setup is simply abandoned; a confirmed factor leaves with its codes.
        await tx.authTotpFactor.delete({ where: { userId: input.userId } });

        return { kind: "disabled" };
      });
    }
  };
}

export function createPrismaSecondFactorSignInRepository(prisma: PrismaClient): SecondFactorSignInRepository {
  return {
    async completeSecondFactorSignIn(input) {
      const { challenge } = input;

      return prisma.$transaction(async (tx): Promise<SecondFactorSignInResult> => {
        // Lock order: the identity (as the first factor took it), then the factor row.
        await lockAuthIdentity(tx, challenge.identityId);
        const identity = await tx.authIdentity.findUnique({
          include: { user: true },
          where: { id: challenge.identityId }
        });

        if (
          !identity ||
          identity.userId !== challenge.userId ||
          identity.provider !== challenge.signInMethod ||
          identity.user.status !== "active" ||
          (challenge.signInMethod === "password" && (!identity.emailVerifiedAt || !identity.passwordHash))
        ) {
          return { kind: "challenge_expired" };
        }

        const factor = await lockTotpFactor(tx, challenge.userId);
        const factorBinding = factor ? await totpFactorBinding(tx, factor) : null;
        const credential = challenge.signInMethod === "password" ? identity.passwordHash : identity.id;

        if (!factor || !factorBinding || !credential || !input.matchesChallenge({ credential, factorBinding })) {
          return { kind: "challenge_expired" };
        }

        const proof = await verifySecondFactorAttempt(tx, {
          attempt: input.attempt,
          factor,
          keys: input.keys,
          now: input.now
        });

        if (!proof) {
          return { kind: "invalid_code" };
        }

        const issued = await issueSignInSession(tx, {
          secondFactor: proof,
          session: input.session,
          signInMethod: challenge.signInMethod,
          userId: challenge.userId
        });

        if (issued.kind !== "session") {
          throw new Error("second_factor_not_accepted");
        }

        return {
          kind: "session",
          user: {
            displayName: identity.user.displayName,
            email: identity.user.email,
            id: identity.user.id,
            role: identity.user.role,
            status: identity.user.status
          }
        };
      });
    }
  };
}
