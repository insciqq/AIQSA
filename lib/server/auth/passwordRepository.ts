import type { PrismaClient } from "@prisma/client";
import type { CreateAuthSessionInput } from "./requestAuth";
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

export type PasswordAuthRepository = {
  createSessionForCurrentPassword(input: {
    identityId: string;
    passwordHash: string;
    session: Omit<CreateAuthSessionInput, "userId">;
  }): Promise<{ user: PasswordIdentityRecord["user"] } | null>;
  completePasswordReset(input: {
    now: Date;
    passwordHash: string;
    tokenHash: string;
  }): Promise<{ userId: string } | null>;
  createPasswordResetToken(input: PasswordResetTokenInput): Promise<void>;
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

        await tx.authSession.create({
          data: {
            ...input.session,
            userId: identity.userId
          }
        });

        return {
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

        return {
          userId: flowToken.identity.userId
        };
      });
    },
    async createPasswordResetToken(input) {
      await prisma.$transaction(async (tx) => {
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
          identity.userId !== input.userId ||
          identity.normalizedEmail !== input.normalizedEmail ||
          !isActiveVerifiedPasswordIdentity(identity)
        ) {
          return;
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
