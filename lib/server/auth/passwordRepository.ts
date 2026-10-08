import type { PrismaClient } from "@prisma/client";
import { revokeInboundMcpGrantsForUser } from "../memoryMcp/oauth/repository";
import type { SecondFactorChallengeSubject } from "./secondFactorChallenge";
import { issueSignInSession, type SignInSessionInput } from "./signInCompletion";
import { lockAuthIdentity } from "./transactionLocks";

export type PasswordIdentityRecord = {
  emailVerifiedAt: Date | string | null;
  id: string;
  normalizedEmail: string;
  passwordHash: string | null;
  user: {
    displayName: string;
    email: string | null;
    id: string;
    role: string;
    status: string;
  };
  userId: string;
};

export type PasswordResetTokenInput = {
  expiresAt: Date;
  identityId: string;
  normalizedEmail: string;
  sentToEmail: string;
  tokenHash: string;
  userId: string;
};

/**
 * A verified password ends in a session, or, for a user with TOTP, in a challenge for the
 * second factor; no session exists before that factor.
 */
export type PasswordSignInResult =
  | { kind: "session"; user: PasswordIdentityRecord["user"] }
  | { challenge: SecondFactorChallengeSubject; kind: "second_factor_required" };

export type PasswordAuthRepository = {
  createSessionForCurrentPassword(input: {
    identityId: string;
    passwordHash: string;
    session: SignInSessionInput;
  }): Promise<PasswordSignInResult | null>;
  /** The normalized email lets the caller clear that account's password-login lock. */
  completePasswordReset(input: {
    now: Date;
    passwordHash: string;
    tokenHash: string;
  }): Promise<{ normalizedEmail: string; userId: string } | null>;
  createPasswordResetToken(input: PasswordResetTokenInput): Promise<boolean>;
  findPasswordIdentityByEmail(normalizedEmail: string): Promise<PasswordIdentityRecord | null>;
};

function isActiveVerifiedPasswordIdentity(identity: PasswordIdentityRecord | null): identity is PasswordIdentityRecord {
  return Boolean(identity?.emailVerifiedAt && identity.user.status === "active");
}

export function createPrismaPasswordAuthRepository(prisma: PrismaClient): PasswordAuthRepository {
  return {
    async createSessionForCurrentPassword(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthIdentity(tx, input.identityId);
        const identity = await tx.authIdentity.findUnique({
          include: {
            user: true
          },
          where: {
            id: input.identityId
          }
        });

        if (
          !identity ||
          identity.provider !== "password" ||
          identity.passwordHash !== input.passwordHash ||
          !isActiveVerifiedPasswordIdentity(identity)
        ) {
          return null;
        }

        const issued = await issueSignInSession(tx, {
          session: input.session,
          signInMethod: "password",
          userId: identity.userId
        });

        // A pending SCIM deactivation answers like any credential that does not sign in.
        if (issued.kind === "refused") {
          return null;
        }

        if (issued.kind === "second_factor_required") {
          return {
            challenge: {
              credential: input.passwordHash,
              factorBinding: issued.factorBinding,
              identityId: identity.id,
              signInMethod: "password",
              userId: identity.userId
            },
            kind: "second_factor_required"
          };
        }

        return {
          kind: "session",
          user: identity.user
        };
      });
    },
    async completePasswordReset(input) {
      return prisma.$transaction(async (tx) => {
        const candidate = await tx.authFlowToken.findUnique({
          select: {
            identityId: true
          },
          where: {
            tokenHash: input.tokenHash
          }
        });

        if (!candidate?.identityId) {
          return null;
        }

        await lockAuthIdentity(tx, candidate.identityId);

        const flowToken = await tx.authFlowToken.findUnique({
          include: {
            identity: {
              include: {
                user: true
              }
            }
          },
          where: {
            tokenHash: input.tokenHash
          }
        });

        if (
          !flowToken ||
          flowToken.purpose !== "password_reset" ||
          flowToken.consumedAt ||
          flowToken.expiresAt <= input.now ||
          !flowToken.identity ||
          !flowToken.userId ||
          flowToken.userId !== flowToken.identity.userId ||
          (flowToken.normalizedEmail !== null &&
            flowToken.normalizedEmail !== flowToken.identity.normalizedEmail) ||
          flowToken.identity.provider !== "password" ||
          !isActiveVerifiedPasswordIdentity(flowToken.identity)
        ) {
          return null;
        }

        const consumed = await tx.authFlowToken.updateMany({
          data: {
            consumedAt: input.now
          },
          where: {
            consumedAt: null,
            id: flowToken.id
          }
        });

        if (consumed.count !== 1) {
          return null;
        }

        await tx.authFlowToken.updateMany({
          data: {
            consumedAt: input.now
          },
          where: {
            consumedAt: null,
            identityId: flowToken.identity.id,
            purpose: "password_reset",
            userId: flowToken.identity.userId
          }
        });

        await tx.authIdentity.update({
          data: {
            passwordHash: input.passwordHash
          },
          where: {
            id: flowToken.identity.id
          }
        });

        await tx.authSession.updateMany({
          data: {
            revokedAt: input.now,
            revokedReason: "password_reset"
          },
          where: {
            revokedAt: null,
            userId: flowToken.identity.userId
          }
        });
        await revokeInboundMcpGrantsForUser(tx, {
          now: input.now,
          reason: "password_reset",
          userId: flowToken.identity.userId
        });

        return {
          normalizedEmail: flowToken.identity.normalizedEmail,
          userId: flowToken.identity.userId
        };
      });
    },
    async createPasswordResetToken(input) {
      return prisma.$transaction(async (tx) => {
        await lockAuthIdentity(tx, input.identityId);
        const identity = await tx.authIdentity.findUnique({
          include: {
            user: true
          },
          where: {
            id: input.identityId
          }
        });

        if (
          !identity ||
          identity.provider !== "password" ||
          identity.userId !== input.userId ||
          identity.normalizedEmail !== input.normalizedEmail ||
          !isActiveVerifiedPasswordIdentity(identity)
        ) {
          return false;
        }

        await tx.authFlowToken.create({
          data: {
            expiresAt: input.expiresAt,
            identityId: input.identityId,
            normalizedEmail: input.normalizedEmail,
            purpose: "password_reset",
            sentToEmail: input.sentToEmail,
            tokenHash: input.tokenHash,
            userId: input.userId
          }
        });
        return true;
      });
    },
    async findPasswordIdentityByEmail(normalizedEmail) {
      return prisma.authIdentity.findUnique({
        include: {
          user: true
        },
        where: {
          provider_normalizedEmail: {
            normalizedEmail,
            provider: "password"
          }
        }
      });
    }
  };
}
